/**
 * Printable "Final bill" page. Plain HTML + inline CSS (no assets, no
 * packages) so it prints / "Save as PDF" cleanly from a phone browser.
 *
 * It is titled "Final bill", NOT "Tax invoice": Keplix does not issue GST tax
 * invoices on the garage's behalf (owner decision, mockup U07).
 * Every dynamic value goes through esc(): garage names, line names and the
 * customer name are user-controlled text.
 */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const money = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dateIst = (d) =>
  d
    ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
    : '';

const qty = (n) => String(Number(n) || 0);

/**
 * @param {object} p
 * @param {object} p.bill  { number, status, issued_at, paid_at, lines[{name,qty,unit_price,line_total}], labour_total, parts_total, total }
 * @param {boolean} p.taxInclusive
 * @param {string} p.garageName
 * @param {string} p.customerName
 * @param {string} p.serviceName
 * @param {number} p.bookingId
 * @param {number|null} [p.platformFee] customer copy only, when the payment is recorded
 * @param {string} p.nonce CSP nonce for the print-button script
 */
export const renderBillHtml = ({ bill, taxInclusive, garageName, customerName, serviceName, bookingId, platformFee = null, nonce }) => {
  const rows = bill.lines
    .map(
      (l) => `<tr><td>${esc(l.name)}</td><td class="n">${esc(qty(l.qty))}</td><td class="n">${esc(money(l.unit_price))}</td><td class="n">${esc(money(l.line_total))}</td></tr>`
    )
    .join('');
  const paid = bill.status === 'paid';
  const fee = platformFee != null && Number(platformFee) > 0 ? Number(platformFee) : null;
  const status = paid ? `Paid${bill.paid_at ? ` on ${esc(dateIst(bill.paid_at))}` : ''}` : 'Payment pending';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Final bill ${esc(bill.number)} - Keplix</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;margin:0;background:#f4f4f4}
.sheet{max-width:720px;margin:16px auto;background:#fff;padding:24px;border-radius:8px}
.brand{font-size:24px;font-weight:700;color:#d9040d}
h1{font-size:20px;margin:4px 0 16px}
.meta{display:flex;flex-wrap:wrap;gap:8px 32px;font-size:14px;margin-bottom:16px}
.meta div{min-width:200px}.meta b{display:block;font-size:12px;color:#666;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:8px 6px;border-bottom:1px solid #e5e5e5;text-align:left}
th{background:#fafafa;font-size:12px;color:#555}.n{text-align:right;white-space:nowrap}
.tot td{border:0;padding:4px 6px}.grand td{font-weight:700;font-size:16px;border-top:2px solid #1a1a1a}
.note{font-size:12px;color:#555;margin-top:16px;line-height:1.5}
button{margin-top:16px;padding:10px 18px;font-size:14px;border:0;border-radius:6px;background:#d9040d;color:#fff}
@media print{body{background:#fff}.sheet{margin:0;padding:0}button{display:none}}
</style></head><body><div class="sheet">
<div class="brand">Keplix</div>
<h1>Final bill</h1>
<div class="meta">
<div><b>Bill number</b>${esc(bill.number)}</div>
<div><b>Date</b>${esc(dateIst(bill.issued_at))}</div>
<div><b>Garage</b>${esc(garageName)}</div>
<div><b>Customer</b>${esc(customerName)}</div>
<div><b>Service</b>${esc(serviceName)}</div>
<div><b>Booking</b>#${esc(bookingId)}</div>
<div><b>Status</b>${status}</div>
</div>
<table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<table class="tot">
<tr><td>Labour</td><td class="n">${esc(money(bill.labour_total))}</td></tr>
<tr><td>Parts</td><td class="n">${esc(money(bill.parts_total))}</td></tr>
<tr class="grand"><td>Total</td><td class="n">${esc(money(bill.total))}</td></tr>
${fee != null ? `<tr><td>Keplix platform fee</td><td class="n">${esc(money(fee))}</td></tr><tr><td>Total paid</td><td class="n">${esc(money(Number(bill.total) + fee))}</td></tr>` : ''}
</table>
<p class="note">${taxInclusive ? 'All prices include applicable taxes.' : 'Prices shown exclude applicable taxes.'}
This is a final bill for the work done, not a tax invoice.</p>
<button type="button" id="p">Print / Save as PDF</button>
</div><script nonce="${esc(nonce)}">document.getElementById('p').addEventListener('click',function(){window.print();});</script></body></html>`;
};
