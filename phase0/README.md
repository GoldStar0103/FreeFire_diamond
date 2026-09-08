# Phase 0 — Discovery

Answers the questions that decide the architecture, before any fulfillment code exists.

| # | Question | Needs API key |
|---|---|---|
| 1 | Is Free Fire a direct top-up, or only redeemable PIN codes? | yes |
| 2 | Which endpoint serves it — `/buy/games` or `/buy/pins`? | yes |
| 3 | Can we validate a player ID and show their nickname before charging? | yes |
| 4 | Is a Server ID required at checkout? | yes |
| 5 | What do the six base denominations cost in USD? | yes |
| 6 | Do the 19 combos hold up on diamonds delivered and on margin? | **no** |

Question 6 is already answered — see [Combo audit](#combo-audit-already-final) below.

## Files

| File | Purpose |
|---|---|
| `catalog.mjs` | The 19 combos and their recipes, transcribed from the client. Source of truth; Phase 1 seeds the database from it. |
| `discover.mjs` | The discovery script. Zero dependencies, uses Node's built-in `fetch`. |
| `out/REPORT.md` | Human-readable report, overwritten each run. |
| `out/discovery-*.json` | Every provider request and response, verbatim. Timestamped, never overwritten. |

## Running it

Node is installed but not on `PATH` on this machine, so call it by full path:

```powershell
# Offline — combo audit only, no key needed
& "C:\Program Files\nodejs\node.exe" phase0\discover.mjs

# Full discovery
$env:RA_API_KEY = "ra_..."
$env:RA_TEST_PLAYER_ID = "123456789"   # a real Free Fire ID
$env:FX_USD_MXN = "18.50"              # today's rate, for margins
& "C:\Program Files\nodejs\node.exe" phase0\discover.mjs
```

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `RA_API_KEY` | for live mode | Bearer token from the reseller panel |
| `RA_TEST_PLAYER_ID` | optional | Real FF ID; enables the validation test |
| `FX_USD_MXN` | optional | USD→MXN rate. Defaults to 18.50 and warns |
| `RA_BASE_URL` | optional | Override the API base URL |
| `RA_CONFIRM_SPEND` | for purchases | Must equal `yes` to permit a live purchase |

### The purchase test

Double-gated, because it spends real money:

```powershell
$env:RA_CONFIRM_SPEND = "yes"
& "C:\Program Files\nodejs\node.exe" phase0\discover.mjs --test-purchase
```

Buys the cheapest denomination (100 💎, ~$10 MXN retail) and reads the wallet
before and after. Beyond confirming delivery, this is the **first proof of the
wallet-delta technique the entire fulfillment engine rests on**: the provider API
has no idempotency key, so when a purchase call times out we have no supported way
to ask whether it went through. If the balance drops by exactly `amount_charged`,
balance comparison can resolve that ambiguity instead. Worth confirming on day one —
the whole reliability design depends on it.

## Decision gate

The script ends with one of:

| Verdict | Meaning | Action |
|---|---|---|
| `GO` | All six SKUs are direct top-ups with validation | Proceed to Phase 1 |
| `GO_NO_VALIDATION` | Direct top-up works, no nickname gate | Proceed, but use double-entry ID confirmation at checkout |
| `PARTIAL` | Some denominations unavailable | Rework the affected recipes with the client |
| `BLOCKED` | PIN codes only, or no FF catalog | **Stop.** The "recarga directa al ID" premise fails — escalate the same day |
| `PENDING` | Offline run | Set `RA_API_KEY` and re-run |

## Combo audit — already final

Runs offline, so it is done. Every recipe was checked against the +10% bonus.
**Four combos deliver fewer diamonds than they advertise:**

| Combo | Advertised | Delivers | Gap |
|---|---|---|---|
| Descuentos Chidos 4800 | 4,800 | 4,796 | **−4** |
| Lluvia de Diamantes 2400 | 2,400 | 2,398 | **−2** |
| Pack Good | 3,600 | 3,564 | **−36** |
| Pack Súper Prime | 11,000 | 10,956 | **−44** |

Every other combo over-delivers, so this reads as deliberate rounding that slipped
negative in four places. Small numbers, but this audience counts diamonds and posts
screenshots in the group.

Fix the advertised figure or the recipe. Phase 3 adds a publish validator to the
admin panel so the monthly flyer rotation can never reintroduce this.

The five Super Pack advertised counts were read from flyer images rather than typed
by the client — they carry `advertisedSource: 'flyer'` in `catalog.mjs` and need
confirming before launch. Two of the four shortfalls are in that group.

## Blocked on

- **API key** — pending the client rotating the panel password. Steps 1–5 cannot run without it.
- **Client confirmation** on the four shortfalls and the five flyer-sourced counts.
- **10% bonus behaviour** on repeated same-SKU calls. Their manual operation implies it
  repeats, but Mega Prime 48k fires 5,600 eight times in one session and that extreme is
  almost certainly untested. If the bonus does not repeat, that pack is ~4,000 diamonds short.

## Note for Phase 1

`git` is not installed on this machine. Needed before repo setup.
