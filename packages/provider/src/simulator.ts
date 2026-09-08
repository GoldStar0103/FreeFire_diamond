/**
 * Provider simulator.
 *
 * A fake RecargasAmérica that can be told to fail in every way the real one can,
 * including the ways that matter most: charging the wallet and *then* failing to
 * respond.
 *
 * The important property is that the simulator holds the ground truth privately.
 * When a behaviour is scripted as `{ mode: 'timeout', charged: true }` it debits
 * the wallet and then throws — exactly as a real timeout-after-commit would. The
 * reconciler is given nothing but the balance and has to reach the right verdict
 * on its own. That is what makes these tests evidence rather than decoration.
 */

import {
  ValidationUnsupportedError,
  type EndpointKind,
  type OrderStatus,
  type PlayerValidation,
  type PurchaseOutcome,
  type PurchaseRequest,
  type TopupProvider,
  type UsdTenK,
} from './types.js';
import { BASE_DENOMINATIONS, type ProviderProduct } from './catalog.js';

export type SimulatedBehavior =
  | { mode: 'succeed' }
  /** Provider returns codes instead of topping up — the project-breaking case. */
  | { mode: 'succeed_as_code'; pins?: string[] }
  /** Accepted, resolves to COMPLETED after N polls. */
  | { mode: 'pending'; completesAfterPolls: number }
  /** Accepted and never resolves. Must escalate, not spin forever. */
  | { mode: 'pending_forever' }
  /** 422 PURCHASE_FAILED. Nothing charged; retry once the wallet is topped up. */
  | { mode: 'insufficient_balance' }
  /** 422 INVALID_PRODUCT_TYPE. A config bug; never retryable. */
  | { mode: 'invalid_product_type' }
  /** 502 PROVIDER_ERROR. `charged` is the truth the reconciler must discover. */
  | { mode: 'provider_error'; charged: boolean }
  /** No response at all. `charged` is likewise hidden from the caller. */
  | { mode: 'timeout'; charged: boolean }
  /** Connection refused before the request was sent. Definitively not charged. */
  | { mode: 'network_error' };

export interface SimulatorOptions {
  initialBalanceUsd?: number;
  /** Cost per provider product id, in USD. */
  prices?: Record<string, number>;
  defaultPriceUsd?: number;
  /** Product ids that support `/pins/validate`. */
  validatableProducts?: string[];
  knownPlayers?: Record<string, string>;
}

const usd = (n: number) => Math.round(n * 10_000) as UsdTenK;

export class SimulatedProviderError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'SimulatedProviderError';
  }
}

export class ProviderSimulator implements TopupProvider {
  private balance: UsdTenK;
  private readonly prices: Record<string, number>;
  private readonly defaultPriceUsd: number;
  private readonly validatable: Set<string>;
  private readonly players: Record<string, string>;

  /** Behaviours consumed in order; the last one repeats once the queue empties. */
  private script: SimulatedBehavior[] = [{ mode: 'succeed' }];
  private pendingOrders = new Map<string, { pollsLeft: number; forever: boolean; product: string }>();
  private sequence = 0;

  /** Every purchase attempt, so tests can assert on double-delivery. */
  readonly attempts: Array<{ request: PurchaseRequest; charged: boolean; at: number }> = [];

  private catalog: ProviderProduct[] | null = null;
  private catalogError: string | null = null;

  constructor(options: SimulatorOptions = {}) {
    this.balance = usd(options.initialBalanceUsd ?? 500);
    this.prices = options.prices ?? {};
    this.defaultPriceUsd = options.defaultPriceUsd ?? 10;
    this.validatable = new Set(options.validatableProducts ?? []);
    this.players = options.knownPlayers ?? {};
  }

  /** Script the next N calls. The final entry repeats indefinitely. */
  program(...behaviors: SimulatedBehavior[]): this {
    if (behaviors.length === 0) throw new Error('program() needs at least one behavior');
    this.script = [...behaviors];
    return this;
  }

  private nextBehavior(): SimulatedBehavior {
    return this.script.length > 1 ? this.script.shift()! : this.script[0]!;
  }

  private priceOf(productId: string): UsdTenK {
    return usd(this.prices[productId] ?? this.defaultPriceUsd);
  }

  /** Ground truth, for assertions. Never exposed through the TopupProvider API. */
  get actualBalance(): UsdTenK {
    return this.balance;
  }

  get deliveryCount(): number {
    return this.attempts.filter((a) => a.charged).length;
  }

  topUp(amountUsd: number): void {
    this.balance = (this.balance + usd(amountUsd)) as UsdTenK;
  }

  async listFreeFireCatalog(): Promise<ProviderProduct[]> {
    if (this.catalogError) throw new Error(this.catalogError);

    return this.catalog ?? [
      // A plausible default: all six denominations as validatable recharges.
      ...BASE_DENOMINATIONS.map(
        (denomination): ProviderProduct => ({
          providerProductId: `d${denomination}`,
          endpointKind: 'pins_recharge',
          name: `Free Fire ${denomination} Diamonds`,
          sku: `FFSIM${denomination}`,
          diamondsBase: denomination,
          costUsd: usd(this.prices[`d${denomination}`] ?? this.defaultPriceUsd),
          requiresServerId: false,
          canValidate: true,
          raw: {},
        }),
      ),
    ];
  }

  /** Override what the catalog returns, to script sync scenarios. */
  programCatalog(products: ProviderProduct[] | null, error?: string): this {
    this.catalog = products;
    this.catalogError = error ?? null;
    return this;
  }

  async getBalance(): Promise<UsdTenK> {
    return this.balance;
  }

  async validatePlayer(providerProductId: string, playerId: string): Promise<PlayerValidation> {
    if (!this.validatable.has(providerProductId)) {
      throw new ValidationUnsupportedError(providerProductId);
    }
    const nickname = this.players[playerId];
    return nickname ? { found: true, nickname } : { found: false, nickname: null };
  }

  async purchase(request: PurchaseRequest): Promise<PurchaseOutcome> {
    const behavior = this.nextBehavior();
    const price = this.priceOf(request.providerProductId);
    const txId = String(++this.sequence);
    const reference = `SIM${this.sequence.toString().padStart(8, '0')}`;

    const debit = () => {
      this.balance = (this.balance - price) as UsdTenK;
    };
    const record = (charged: boolean) =>
      this.attempts.push({ request, charged, at: Date.now() });

    switch (behavior.mode) {
      case 'succeed': {
        if (this.balance < price) return this.insufficient(record);
        debit();
        record(true);
        return {
          kind: 'succeeded',
          providerTransactionId: txId,
          providerReference: request.endpointKind === 'games' ? reference : null,
          amountCharged: price,
        };
      }

      case 'succeed_as_code': {
        if (this.balance < price) return this.insufficient(record);
        debit();
        record(true);
        return {
          kind: 'delivered_as_code',
          providerTransactionId: txId,
          pins: behavior.pins ?? ['SIM-CODE-0001'],
          amountCharged: price,
        };
      }

      case 'pending': {
        if (this.balance < price) return this.insufficient(record);
        debit();
        record(true);
        this.pendingOrders.set(reference, {
          pollsLeft: behavior.completesAfterPolls,
          forever: false,
          product: request.providerProductId,
        });
        return {
          kind: 'pending',
          providerTransactionId: txId,
          providerReference: reference,
          amountCharged: price,
        };
      }

      case 'pending_forever': {
        if (this.balance < price) return this.insufficient(record);
        debit();
        record(true);
        this.pendingOrders.set(reference, {
          pollsLeft: Number.POSITIVE_INFINITY,
          forever: true,
          product: request.providerProductId,
        });
        return {
          kind: 'pending',
          providerTransactionId: txId,
          providerReference: reference,
          amountCharged: price,
        };
      }

      case 'insufficient_balance':
        return this.insufficient(record);

      case 'invalid_product_type':
        record(false);
        return {
          kind: 'failed',
          code: 'INVALID_PRODUCT_TYPE',
          message: 'Este producto no es de tipo recarga.',
          retryable: false,
          httpStatus: 422,
        };

      case 'provider_error': {
        // The whole point: the wallet may or may not have moved, and the
        // response tells the caller nothing either way.
        if (behavior.charged) debit();
        record(behavior.charged);
        return {
          kind: 'ambiguous',
          reason: 'provider_error',
          message: 'El proveedor rechazó la orden.',
          httpStatus: 502,
        };
      }

      case 'timeout': {
        if (behavior.charged) debit();
        record(behavior.charged);
        return {
          kind: 'ambiguous',
          reason: 'timeout',
          message: 'Request timed out with no response',
          httpStatus: null,
        };
      }

      case 'network_error':
        record(false);
        return {
          kind: 'ambiguous',
          reason: 'network',
          message: 'ECONNREFUSED',
          httpStatus: null,
        };
    }
  }

  private insufficient(record: (charged: boolean) => void): PurchaseOutcome {
    record(false);
    return {
      kind: 'failed',
      code: 'PURCHASE_FAILED',
      message: 'Saldo insuficiente.',
      retryable: true,
      httpStatus: 422,
    };
  }

  async getOrderStatus(reference: string): Promise<OrderStatus | null> {
    const order = this.pendingOrders.get(reference);
    if (!order) return null;

    if (order.forever) {
      return { reference, status: 'PENDING', pins: [], product: null };
    }

    order.pollsLeft -= 1;
    if (order.pollsLeft > 0) {
      return { reference, status: 'PENDING', pins: [], product: null };
    }

    this.pendingOrders.delete(reference);
    return { reference, status: 'COMPLETED', pins: [], product: order.product };
  }
}
