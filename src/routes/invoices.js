// Payments: service fees and invoices (the Payments tab). Every route is scoped to the logged-in admin (req.user.fb_id).
// Mounted on the /api router by server.js: require('./src/routes/invoices')(api, { wrap, isDay, isFull }).
const db = require('../db');
const sync = require('../sync');
const telegram = require('../telegram');
const invoice = require('../invoice');

module.exports = function mountInvoices(api, { wrap, isDay, isFull }) {
  const lastOfMonth = (ym) => `${ym}-${String(new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
  const IMG = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
  async function invoiceProfile(owner) { return invoice.profileOf(await db.getUserSetting(owner, 'invoiceProfile', {})); }
  api.get('/payments', wrap(async (req, res) => {
    const ym = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : sync.todayIn().slice(0, 7);
    const [clients, invoices] = await Promise.all([db.listClients(req.user.fb_id), db.listInvoices(req.user.fb_id, ym + '-01', lastOfMonth(ym))]);
    res.json({
      month: ym, today: sync.todayIn(),
      clients: clients.filter((c) => !c.archived).map((c) => ({ id: c.id, name: c.name, pages: c.pages, telegram: c.telegram, telegramTitle: c.telegram_title, service: c.service })),
      invoices, bot: telegram.hasBot(),
      tgSent: Object.fromEntries(Object.entries(await sentInvoices(req.user.fb_id)).map(([k, v]) => [k, { at: v.at, to: v.to }])),
    });
  }));
  // Invoices sent to Telegram in the last 48 hours (a bot can delete its own messages only that long).
  async function sentInvoices(owner) {
    const all = (await db.getUserSetting(owner, 'sentInvoices', {})) || {}, out = {};
    for (const [k, v] of Object.entries(all)) if (v && Date.now() - Date.parse(v.at) < 48 * 3600e3) out[k] = v;
    return out;
  }
  api.post('/invoices/:id/unsend', wrap(async (req, res) => {
    const inv = await db.getInvoice(req.user.fb_id, Number(req.params.id)); if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    const all = await sentInvoices(req.user.fb_id), rec = all[inv.id];
    if (!rec) return res.status(404).json({ error: 'This invoice was not sent in the last 48 hours — delete it in Telegram instead (group admins can).' });
    let ok = 0;
    for (const m of rec.msgs) if (await telegram.remove(m.chat, m.id)) ok++;
    delete all[inv.id]; await db.setUserSetting(req.user.fb_id, 'sentInvoices', all);
    await db.markInvoice(req.user.fb_id, inv.id, { sent: false });
    res.json({ ok: true, deleted: ok, failed: rec.msgs.length - ok });
  }));
  const withMessage = async (owner) => { const saved = await db.getUserSetting(owner, 'invoiceProfile', {}); return { ...(await invoiceProfile(owner)), message: saved.message || invoice.DEFAULT_MESSAGE, defaultMessage: invoice.DEFAULT_MESSAGE }; };
  api.get('/invoice-profile', wrap(async (req, res) => res.json(await withMessage(req.user.fb_id))));
  api.put('/invoice-profile', wrap(async (req, res) => {
    const b = req.body || {}, cur = await db.getUserSetting(req.user.fb_id, 'invoiceProfile', {}), next = { ...cur };
    for (const k of ['company', 'address1', 'address2', 'phone', 'bankName', 'accountName', 'accountNo', 'seller', 'issuedBy']) if (b[k] != null) next[k] = String(b[k]).trim().slice(0, 160);
    for (const k of ['logo', 'qr', 'sign']) if (b[k] != null) { if (b[k] !== '' && (!IMG.test(b[k]) || b[k].length > 450000)) return res.status(400).json({ error: 'Pictures must be PNG or JPG, up to about 300 KB each.' }); next[k] = b[k]; }
    if (b.message != null) { const m = String(b.message).replace(/\r/g, '').slice(0, 900); next.message = m.trim() && m !== invoice.DEFAULT_MESSAGE ? m : ''; }
    await db.setUserSetting(req.user.fb_id, 'invoiceProfile', next);
    if (b.nextNumber != null && (await isFull(req))) { const n = parseInt(b.nextNumber, 10); if (n > 0 && n < 1e7) await db.setSetting('invoiceSeq', n - 1); }
    res.json(await withMessage(req.user.fb_id));
  }));
  const autoNumber = async (date) => `IN${String(date || sync.todayIn()).slice(2, 4)}-${String((Number(await db.getSetting('invoiceSeq', 0)) || 0) + 1).padStart(4, '0')}`;
  const cleanNumber = (v) => String(v == null ? '' : v).replace(/[^\p{L}\p{N} ._/#-]+/gu, '').trim().slice(0, 30);
  api.get('/invoice-next', wrap(async (req, res) => res.json({ next: (Number(await db.getSetting('invoiceSeq', 0)) || 0) + 1, number: await autoNumber(isDay(req.query.date) ? req.query.date : ''), canSet: await isFull(req) })));
  function cleanInvoice(b, c) {
    const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 6).map((it) => ({ description: str(it.description, 160), qty: Math.max(0, Number(it.qty) || 0), price: Math.max(0, Number(it.price) || 0) })).filter((it) => it.description || it.price);
    const data = { customer: str(b.customer, 120) || c.service.customer || c.name, company: str(b.company, 120), phone: str(b.phone, 40), items, discount: Math.max(0, Number(b.discount) || 0) };
    const t = invoice.totals(data); data.discount = t.discount;
    return { data, total: t.total };
  }
  api.post('/invoices/preview', wrap(async (req, res) => { // PNG of an invoice that isn't saved yet
    const b = req.body || {}, c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(b.clientId));
    if (!c) return res.status(404).json({ error: 'Client not found.' });
    if (!isDay(b.date)) return res.status(400).json({ error: 'Pick the invoice date.' });
    const { data } = cleanInvoice(b, c);
    const next = cleanNumber(b.number) || await autoNumber(b.date);
    res.set('content-type', 'image/png').set('cache-control', 'no-store').send(await invoice.png({ ...data, number: next, date: b.date }, await db.getUserSetting(req.user.fb_id, 'invoiceProfile', {})));
  }));
  api.post('/invoices', wrap(async (req, res) => {
    const b = req.body || {}, c = (await db.listClients(req.user.fb_id)).find((x) => x.id === Number(b.clientId));
    if (!c) return res.status(404).json({ error: 'Client not found.' });
    if (!isDay(b.date)) return res.status(400).json({ error: 'Pick the invoice date.' });
    const { data, total } = cleanInvoice(b, c);
    if (!data.items.length) return res.status(400).json({ error: 'Add at least one line with a description or price.' });
    // A typed invoice number is used as it is; left as suggested (or empty), the next running number is taken.
    let number = cleanNumber(b.number);
    if (number && number === await autoNumber(b.date)) number = '';
    if (number && await db.invoiceNumberUsed(number)) return res.status(409).json({ error: `Invoice number ${number} is already used. Type a different one.` });
    res.json(await db.createInvoice(req.user.fb_id, { clientId: c.id, date: b.date, data, total, number }, req.user.name));
  }));
  const invFile = (inv) => `${String(inv.company || inv.customer || 'Invoice').replace(/[^\p{L}\p{N} ._-]+/gu, '').trim() || 'Invoice'} ${inv.number}.pdf`;
  api.get('/invoices/:id/pdf', wrap(async (req, res) => {
    const inv = await db.getInvoice(req.user.fb_id, Number(req.params.id)); if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    const buf = await invoice.pdf(inv, await db.getUserSetting(req.user.fb_id, 'invoiceProfile', {}));
    res.set('content-type', 'application/pdf').set('content-disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(invFile(inv))}`).send(buf);
  }));
  api.get('/invoices/:id/png', wrap(async (req, res) => {
    const inv = await db.getInvoice(req.user.fb_id, Number(req.params.id)); if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    res.set('content-type', 'image/png').set('cache-control', 'no-store').send(await invoice.png(inv, await db.getUserSetting(req.user.fb_id, 'invoiceProfile', {})));
  }));
  api.post('/invoices/:id/send', wrap(async (req, res) => {
    const inv = await db.getInvoice(req.user.fb_id, Number(req.params.id)); if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    const c = (await db.listClients(req.user.fb_id)).find((x) => x.id === inv.clientId);
    if (!c || !c.telegram) return res.status(400).json({ error: `${c ? c.name : 'This client'} has no Telegram group yet. Pick one in the Clients tab.` });
    // The invoice goes to the group as a picture (opens right in the chat); the PDF stays available in the app.
    const buf = await invoice.png(inv, await db.getUserSetting(req.user.fb_id, 'invoiceProfile', {}), 1654);
    // Message sent with the picture: the account's own template (Invoice settings), or the default Khmer reminder.
    const saved = await db.getUserSetting(req.user.fb_id, 'invoiceProfile', {});
    const caption = invoice.fillMessage(saved.message, invoice.messageValues(inv, c.service && c.service.day));
    const track = [];
    await telegram.sendPhoto(buf, caption, c.telegram, track);
    if (track.length) {
      const all = await sentInvoices(req.user.fb_id), old = all[inv.id] ? all[inv.id].msgs : [];
      all[inv.id] = { at: new Date().toISOString(), to: c.telegram_title || c.telegram, msgs: [...old, ...track].slice(-20) };
      await db.setUserSetting(req.user.fb_id, 'sentInvoices', all);
    }
    res.json({ ...(await db.markInvoice(req.user.fb_id, inv.id, { sent: true })), sentTo: c.telegram_title || c.telegram });
  }));
  api.patch('/invoices/:id', wrap(async (req, res) => {
    const inv = await db.getInvoice(req.user.fb_id, Number(req.params.id)); if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    const b = req.body || {};
    if (b.number !== undefined) {
      const number = cleanNumber(b.number);
      if (!number) return res.status(400).json({ error: 'Type the invoice number.' });
      if (await db.invoiceNumberUsed(number, inv.id)) return res.status(409).json({ error: `Invoice number ${number} is already used. Type a different one.` });
      if (number !== inv.number) await db.renumberInvoice(req.user.fb_id, inv.id, number);
    }
    res.json(await db.markInvoice(req.user.fb_id, inv.id, { paid: b.paid === undefined ? undefined : !!b.paid }));
  }));
  api.delete('/invoices/:id', wrap(async (req, res) => { await db.deleteInvoice(req.user.fb_id, Number(req.params.id)); res.json({ ok: true }); }));
};
