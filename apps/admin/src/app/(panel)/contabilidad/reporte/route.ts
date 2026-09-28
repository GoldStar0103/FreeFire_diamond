import { NextResponse } from 'next/server';
import { getAccountingSummary, mexicoCityTodayYmd } from '@levelup/db';
import { getDb } from '../../../../lib/db';
import { requireSession } from '../../../../lib/session';
import { methodLabel, parseRangeKey, resolveRange } from '../range';

/**
 * The "generar reporte" button the client asked for — a CSV of exactly what
 * the Contabilidad page is showing for the same range, so it can be opened in
 * Excel/Sheets or handed to an accountant. Plain numbers, not `$1,234.56`
 * formatting: a currency-formatted MXN string can itself contain a comma
 * (thousands separator), which would silently corrupt a naive CSV parse.
 */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const centsToDecimal = (cents: number): string => (cents / 100).toFixed(2);

function formatDateTime(d: Date): string {
  return new Intl.DateTimeFormat('es-MX', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Mexico_City',
  }).format(d);
}

export async function GET(request: Request) {
  await requireSession();

  const url = new URL(request.url);
  const rango = parseRangeKey(url.searchParams.get('rango') ?? undefined);
  const desde = url.searchParams.get('desde') ?? undefined;
  const hasta = url.searchParams.get('hasta') ?? undefined;
  const range = resolveRange(rango, desde, hasta);

  const summary = await getAccountingSummary(getDb(), range);

  const lines: string[] = [];
  lines.push('LevelUp Store - Reporte de Contabilidad');
  lines.push(`Rango,${rango}`);
  if (rango === 'personalizado') {
    lines.push(`Desde,${desde ?? ''}`);
    lines.push(`Hasta,${hasta ?? ''}`);
  }
  lines.push('');

  lines.push('Resumen');
  lines.push(`Ventas brutas,${centsToDecimal(summary.grossSalesCents)}`);
  lines.push(`Costo de recargas,${centsToDecimal(summary.recargaCostCents)}`);
  lines.push(`Comision estimada,${centsToDecimal(summary.estimatedFeeCents)}`);
  lines.push(`Ganancia neta,${centsToDecimal(summary.estimatedProfitCents)}`);
  lines.push(`Pedidos completados,${summary.orderCounts.completed}`);
  lines.push(`Pedidos pendientes,${summary.orderCounts.pending}`);
  lines.push(`Pedidos cancelados,${summary.orderCounts.cancelled}`);
  lines.push('');

  lines.push('Por metodo de pago');
  lines.push('Metodo,Pedidos,Total');
  for (const m of summary.totalsByMethod) {
    lines.push(
      [csvField(methodLabel(m.method, m.gateway)), String(m.count), centsToDecimal(m.totalCents)].join(','),
    );
  }
  lines.push('');

  lines.push('Historial de movimientos');
  lines.push('Pedido,Combo,Precio,Metodo,Ganancia neta,Fecha');
  for (const m of summary.movements) {
    lines.push(
      [
        csvField(m.orderNumber),
        csvField(m.comboName),
        centsToDecimal(m.priceMxnCents),
        csvField(m.paymentMethod ? methodLabel(m.paymentMethod, m.paymentGateway) : ''),
        m.netProfitCents === null ? 'N/D' : centsToDecimal(m.netProfitCents),
        csvField(formatDateTime(m.completedAt)),
      ].join(','),
    );
  }

  // Leading BOM so Excel on Windows (the client's own setup) reads the UTF-8
  // accents (á, ó, í) correctly instead of mangling them.
  const csv = '﻿' + lines.join('\r\n');
  const filename = `contabilidad-${rango}-${mexicoCityTodayYmd()}.csv`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
