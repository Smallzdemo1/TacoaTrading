(function () {
  'use strict';

  var cfg = window.TACOA_SUPABASE;
  var db = window.supabase.createClient(cfg.url, cfg.anonKey);

  var panel = document.getElementById('panel');
  var loginView = document.getElementById('login-view');
  var appView = document.getElementById('app-view');
  var toastEl = document.getElementById('toast');

  var products = [];
  var current = 'overview';
  var editing = null;
  var toastTimer = null;

  // ---------------------------------------------------------------- helpers

  var moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  function money(n) { return moneyFmt.format(Number(n) || 0); }
  function fmtDate(d) {
    return new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function pct(n) { return (Math.round(n * 10) / 10) + '%'; }
  // Quantities are square metres, shown with up to 2 decimals.
  function qtyFmt(n) { return (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }); }

  // Builds DOM nodes with text only (never innerHTML), so stored data cannot inject markup.
  function h(tag, props) {
    var node = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else node.setAttribute(k, v === true ? '' : v);
    });
    Array.prototype.slice.call(arguments, 2).forEach(function add(kid) {
      if (Array.isArray(kid)) { kid.forEach(add); return; }
      if (kid === null || kid === undefined || kid === false) return;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    });
    return node;
  }

  function field(label, input) { return h('label', { class: 'field' }, h('span', {}, label), input); }

  function table(headers, rows, numCols) {
    numCols = numCols || [];
    if (!rows.length) return h('p', { class: 'empty' }, 'Nothing here yet.');
    return h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, headers.map(function (t, i) {
        return h('th', { class: numCols.indexOf(i) > -1 ? 'num' : '' }, t);
      }))),
      h('tbody', {}, rows.map(function (cells) {
        var cls = cells.rowClass || '';
        return h('tr', { class: cls }, cells.map(function (c, i) {
          return h('td', { class: numCols.indexOf(i) > -1 ? 'num' : '' }, c);
        }));
      }))
    ));
  }

  function card(title) {
    var kids = Array.prototype.slice.call(arguments, 1);
    return h('section', { class: 'card' }, title ? h('h3', {}, title) : null, kids);
  }

  function stat(label, value, sub, tone) {
    return h('div', { class: 'stat' },
      h('div', { class: 'label' }, label),
      h('div', { class: 'value ' + (tone || '') }, value),
      sub ? h('div', { class: 'sub' }, sub) : null);
  }

  function toast(message, kind) {
    toastEl.textContent = message;
    toastEl.className = 'toast' + (kind === 'error' ? ' error' : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 4500);
  }

  function must(result) {
    if (result.error) throw result.error;
    return result.data;
  }

  function productSelect(showStock) {
    var sel = h('select', { required: true },
      h('option', { value: '' }, 'Select a product…'),
      products.map(function (p) {
        return h('option', { value: p.id },
          p.product_name + (showStock ? ' (' + qtyFmt(p.stock_on_hand) + ' sqm in stock)' : ''));
      }));
    return sel;
  }

  function productById(id) {
    return products.filter(function (p) { return p.id === id; })[0];
  }

  function numberInput(opts) {
    return h('input', Object.assign({ type: 'number', required: true }, opts));
  }

  // Runs a form action: disables the button, reports errors, refreshes the current tab.
  function submitHandler(action, okMessage) {
    return function (e) {
      e.preventDefault();
      var form = e.currentTarget;
      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      Promise.resolve().then(function () { return action(form); }).then(function () {
        toast(okMessage, 'ok');
        return showTab(current);
      }).catch(function (err) {
        toast((err && err.message) || 'Something went wrong.', 'error');
        btn.disabled = false;
      });
    };
  }

  function loadProducts() {
    return db.from('inventory').select('*').order('product_name').then(function (r) {
      products = must(r);
    });
  }

  function dayRange(fromStr, toStr) {
    // Inclusive dates from the pickers -> [from, to) timestamps in local time.
    var from = null;
    var to = null;
    if (fromStr) { var f = fromStr.split('-'); from = new Date(+f[0], +f[1] - 1, +f[2]); }
    if (toStr) { var t = toStr.split('-'); to = new Date(+t[0], +t[1] - 1, +t[2] + 1); }
    return { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null };
  }

  function isoDay(d) {
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  // ---------------------------------------------------------------- overview

  function renderOverview() {
    var now = new Date();
    var monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    return Promise.all([
      loadProducts(),
      db.rpc('accounting_report', { p_from: monthStart, p_to: null }),
      db.from('leads').select('id', { count: 'exact', head: true }).eq('status', 'new')
    ]).then(function (res) {
      var rep = must(res[1])[0];
      var newLeads = res[2].error ? 0 : res[2].count;
      var stockValue = 0;
      var retailValue = 0;
      products.forEach(function (p) {
        stockValue += Number(p.stock_on_hand) * Number(p.unit_cost);
        retailValue += Number(p.stock_on_hand) * Number(p.selling_price);
      });
      var low = products.filter(function (p) { return Number(p.stock_on_hand) <= Number(p.reorder_level); });
      var net = Number(rep.net_profit);

      panel.replaceChildren(
        h('h2', {}, 'Overview'),
        h('div', { class: 'stats' },
          stat('Sales this month', money(rep.revenue_total)),
          stat('Net profit this month', money(net), null, net >= 0 ? 'pos' : 'neg'),
          stat('Stock value (at cost)', money(stockValue), 'Retail value ' + money(retailValue)),
          stat('Write-offs this month', money(rep.writeoffs_total), 'Breakages and losses', Number(rep.writeoffs_total) > 0 ? 'neg' : ''),
          stat('New enquiries', String(newLeads), 'Waiting for a reply')
        ),
        card('Low stock',
          table(['Product', 'In stock (sqm)', 'Reorder level (sqm)'],
            low.map(function (p) {
              return [p.product_name, h('span', { class: 'badge ' + (Number(p.stock_on_hand) === 0 ? 'bad' : 'warn') }, qtyFmt(p.stock_on_hand)), qtyFmt(p.reorder_level)];
            }), [1, 2]))
      );
    });
  }

  // --------------------------------------------------------------- inventory

  function renderInventory() {
    return loadProducts().then(function () {
      var e = editing;
      var name = h('input', { type: 'text', required: true, maxlength: 120, value: e ? e.product_name : '' });
      var category = h('input', { type: 'text', required: true, maxlength: 80, list: 'categories', value: e ? e.category : '' });
      var cats = {};
      products.forEach(function (p) { cats[p.category] = true; });
      var datalist = h('datalist', { id: 'categories' }, Object.keys(cats).map(function (c) { return h('option', { value: c }); }));
      var cost = numberInput({ min: '0', step: '0.01', value: e ? e.unit_cost : '' });
      var price = numberInput({ min: '0', step: '0.01', value: e ? e.selling_price : '' });
      var reorder = numberInput({ min: '0', step: '0.01', value: e ? e.reorder_level : '0' });
      var opening = e ? null : numberInput({ min: '0', step: '0.01', value: '0' });

      var form = h('form', { onsubmit: submitHandler(function () {
        var row = {
          product_name: name.value.trim(),
          category: category.value.trim(),
          unit_cost: parseFloat(cost.value),
          selling_price: parseFloat(price.value),
          reorder_level: parseFloat(reorder.value)
        };
        if (e) {
          return db.from('inventory').update(Object.assign({ updated_at: new Date().toISOString() }, row)).eq('id', e.id).then(function (r) {
            must(r);
            editing = null;
          });
        }
        return db.from('inventory').insert([row]).select().single().then(function (r) {
          var created = must(r);
          var qty = parseFloat(opening.value) || 0;
          if (qty > 0) {
            return db.rpc('record_adjustment', {
              p_product_id: created.id, p_type: 'manual_adjustment', p_qty: qty, p_reason: 'Opening stock'
            }).then(must);
          }
        });
      }, e ? 'Product updated' : 'Product added') },
        h('div', { class: 'form-grid' },
          field('Product name', name), field('Category', category), datalist,
          field('Cost per sqm ($)', cost), field('Selling price per sqm ($)', price),
          field('Reorder level (sqm)', reorder), opening ? field('Opening stock (sqm)', opening) : null),
        h('div', { class: 'form-actions' },
          h('button', { type: 'submit', class: 'btn btn-primary' }, e ? 'Save changes' : 'Add product'),
          e ? h('button', { type: 'button', class: 'btn btn-small', onclick: function () { editing = null; showTab('inventory'); } }, 'Cancel') : null),
        h('p', { class: 'hint' }, 'Stock quantities change only through Purchases, Sales and Breakages & Loss, so the books always match the shelf.')
      );

      var rows = products.map(function (p) {
        var margin = Number(p.selling_price) > 0 ? ((p.selling_price - p.unit_cost) / p.selling_price) * 100 : 0;
        var low = Number(p.stock_on_hand) <= Number(p.reorder_level);
        return [
          p.product_name, p.category,
          h('span', { class: 'badge ' + (Number(p.stock_on_hand) === 0 ? 'bad' : low ? 'warn' : '') }, qtyFmt(p.stock_on_hand)),
          money(p.unit_cost), money(p.selling_price), pct(margin),
          money(p.stock_on_hand * p.unit_cost),
          h('button', { type: 'button', class: 'btn btn-small', onclick: function () {
            editing = p; showTab('inventory'); window.scrollTo(0, 0);
          } }, 'Edit')
        ];
      });

      panel.replaceChildren(
        h('h2', {}, 'Inventory'),
        card(e ? 'Edit product' : 'Add product', form),
        card('Products', table(['Product', 'Category', 'In stock (sqm)', 'Cost / sqm', 'Price / sqm', 'Margin', 'Stock value', ''], rows, [2, 3, 4, 5, 6]))
      );
    });
  }

  // ------------------------------------------------------------------- sales

  var cart = [];            // [{ product_id, name, qty, price }]
  var viewingReceipt = null;
  var saleDraft = { name: '', phone: '', email: '' };

  function receiptNo(n) { return 'TAC-' + String(n).padStart(6, '0'); }

  function fetchReceipt(id) {
    return db.from('receipts')
      .select('*, sales(qty_sold, unit_price, total_amount, inventory(product_name))')
      .eq('id', id).single().then(must);
  }

  function receiptPdfName(r) { return 'Receipt-' + receiptNo(r.receipt_no) + '.pdf'; }

  function firstName(full) { return String(full || '').trim().split(' ')[0]; }

  // A document spec drives the PDF and the WhatsApp message, so receipts and quotes share one code path.
  function receiptSpec(r) {
    var f = firstName(r.customer_name);
    return {
      title: 'RECEIPT',
      number: receiptNo(r.receipt_no),
      dateLine: fmtDate(r.created_at),
      who: [r.customer_name || 'Walk-in customer', r.customer_phone, r.customer_email].filter(Boolean),
      lines: (r.sales || []).map(function (s) {
        return { name: s.inventory ? s.inventory.product_name : 'Item', qty: s.qty_sold, price: s.unit_price, amount: s.total_amount };
      }),
      total: r.total_amount,
      footer: ['Thank you for your business. Please keep this receipt as proof of purchase.'],
      fileName: receiptPdfName(r),
      phone: r.customer_phone,
      whatsappText: (f ? 'Hi ' + f + ', here' : 'Here') + ' is your receipt ' + receiptNo(r.receipt_no) +
        ' from Tacoa General Trading. Total: ' + money(r.total_amount) + '. Thank you!'
    };
  }

  function buildPdf(d) {
    var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
    var L = 15, R = 195, y = 20;

    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(14, 77, 43);
    doc.text('Tacoa General Trading', L, y);
    doc.setFontSize(20); doc.text(d.title, R, y, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90, 90, 90);
    doc.text('913 Industrial Road, Kwekwe, Midlands, Zimbabwe', L, y + 6);
    doc.text('+263 77 772 6221  |  info@tacoatrading.com', L, y + 11);
    doc.text(d.number, R, y + 6, { align: 'right' });
    doc.text(d.dateLine, R, y + 11, { align: 'right' });

    y += 24;
    doc.setDrawColor(204, 229, 216); doc.line(L, y - 6, R, y - 6);
    doc.setTextColor(23, 42, 31); doc.setFontSize(10);
    doc.setFont('helvetica', 'bold'); doc.text('Customer', L, y);
    doc.setFont('helvetica', 'normal');
    var who = d.who;
    who.forEach(function (t, i) { doc.text(String(t), L, y + 5 + i * 5); });
    y += 5 + who.length * 5 + 6;

    function header() {
      doc.setFillColor(234, 245, 239); doc.rect(L, y - 5, R - L, 8, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(14, 77, 43);
      doc.text('ITEM', L + 2, y);
      doc.text('QTY (SQM)', 128, y, { align: 'right' });
      doc.text('PRICE / SQM', 160, y, { align: 'right' });
      doc.text('AMOUNT', R - 2, y, { align: 'right' });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(23, 42, 31);
      y += 8;
    }
    header();

    d.lines.forEach(function (s) {
      var name = doc.splitTextToSize(s.name, 80);
      var rowH = name.length * 5 + 3;
      if (y + rowH > 265) { doc.addPage(); y = 20; header(); }
      doc.text(name, L + 2, y);
      doc.text(qtyFmt(s.qty), 128, y, { align: 'right' });
      doc.text(money(s.price), 160, y, { align: 'right' });
      doc.text(money(s.amount), R - 2, y, { align: 'right' });
      y += rowH;
      doc.setDrawColor(230, 238, 233); doc.line(L, y - 3, R, y - 3);
    });

    if (y + 22 > 280) { doc.addPage(); y = 20; }
    y += 4;
    doc.setDrawColor(14, 77, 43); doc.setLineWidth(0.5); doc.line(110, y - 5, R, y - 5);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    doc.text('Total', 128, y + 1, { align: 'right' });
    doc.text(money(d.total), R - 2, y + 1, { align: 'right' });

    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90, 90, 90);
    var foot = [];
    d.footer.forEach(function (t) { foot = foot.concat(doc.splitTextToSize(t, R - L)); });
    var fy = y + 16;
    if (fy + foot.length * 4.5 > 285) { doc.addPage(); fy = 20; }
    doc.text(foot, L, fy);
    return doc;
  }

  // Zimbabwe numbers: 077... -> 26377..., +263... and 00263... are accepted as they are.
  function waNumber(phone) {
    var d = String(phone || '').replace(/\D/g, '');
    if (d.indexOf('00') === 0) return d.slice(2);
    if (d.charAt(0) === '0') return '263' + d.slice(1);
    return d;
  }

  function shareOnWhatsApp(d) {
    var doc = buildPdf(d);
    var name = d.fileName;
    var text = d.whatsappText;
    var file = new File([doc.output('blob')], name, { type: 'application/pdf' });

    // Phones: the share sheet attaches the PDF and WhatsApp is one of the choices.
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], text: text, title: name }).catch(function (e) {
        if (!e || e.name !== 'AbortError') toast('Could not open sharing. Use Download PDF instead.', 'error');
      });
      return;
    }
    // Computers: save the PDF and open the customer's WhatsApp chat to attach it.
    doc.save(name);
    window.open('https://wa.me/' + waNumber(d.phone) + '?text=' + encodeURIComponent(text), '_blank', 'noopener');
    toast('PDF saved. In the WhatsApp chat, attach it with the paperclip.');
  }

  function receiptCard(r) {
    var lines = r.sales || [];
    var emailIn = h('input', { type: 'email', maxlength: 254, placeholder: 'customer@example.com', value: r.customer_email || '' });
    var sendBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: function () {
      var to = emailIn.value.trim();
      if (!to || !emailIn.checkValidity()) { toast('Enter a valid email address.', 'error'); return; }
      sendBtn.disabled = true;
      var b64 = buildPdf(receiptSpec(r)).output('datauristring').split(',')[1];
      invokeFn('send-receipt', { receiptId: r.id, to: to, pdfBase64: b64 }).then(function () {
        toast('Receipt emailed to ' + to, 'ok');
        sendBtn.textContent = 'Email again';
      }).catch(function (err) {
        toast((err && err.message) || 'The email could not be sent.', 'error');
      }).then(function () { sendBtn.disabled = false; });
    } }, r.emailed_at ? 'Email again' : 'Email receipt');

    var rows = lines.map(function (s) {
      return [s.inventory ? s.inventory.product_name : '\u2014', qtyFmt(s.qty_sold), money(s.unit_price), money(s.total_amount)];
    });
    var totalRow = ['Total', '', '', money(r.total_amount)];
    totalRow.rowClass = 'total';
    rows.push(totalRow);

    return card('Receipt ' + receiptNo(r.receipt_no),
      h('p', { class: 'muted' }, fmtDate(r.created_at) + ' \u00b7 ' +
        (r.customer_name || 'Walk-in customer') + (r.customer_phone ? ' \u00b7 ' + r.customer_phone : '')),
      table(['Item', 'Qty (sqm)', 'Price / sqm', 'Amount'], rows, [1, 2, 3]),
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { buildPdf(receiptSpec(r)).save(receiptPdfName(r)); } }, 'Download PDF'),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { shareOnWhatsApp(receiptSpec(r)); } }, 'Send on WhatsApp'),
        h('button', { type: 'button', class: 'btn btn-small', onclick: function () { viewingReceipt = null; showTab('sales'); } }, 'Close')),
      h('div', { class: 'form-grid', style: 'margin-top:14px' },
        field('Email to', emailIn), h('div', {}, sendBtn)),
      r.emailed_at ? h('p', { class: 'hint' }, 'Last emailed ' + fmtDate(r.emailed_at) + '.') : null,
      h('p', { class: 'hint' }, 'WhatsApp: on a phone this attaches the PDF through the share menu. On a computer the PDF is saved and the customer\u2019s chat opens so you can attach it.'));
  }

  function renderSales() {
    return Promise.all([
      loadProducts(),
      db.from('receipts').select('id, receipt_no, customer_name, total_amount, created_at, emailed_at')
        .order('created_at', { ascending: false }).limit(50),
      viewingReceipt ? fetchReceipt(viewingReceipt) : Promise.resolve(null)
    ]).then(function (res) {
      var history = must(res[1]);
      var open = res[2];

      var customer = h('input', { type: 'text', maxlength: 120, value: saleDraft.name });
      var phone = h('input', { type: 'tel', maxlength: 40, placeholder: '0777 123 456', value: saleDraft.phone });
      var email = h('input', { type: 'email', maxlength: 254, placeholder: 'optional', value: saleDraft.email });
      customer.addEventListener('input', function () { saleDraft.name = customer.value; });
      phone.addEventListener('input', function () { saleDraft.phone = phone.value; });
      email.addEventListener('input', function () { saleDraft.email = email.value; });

      var product = productSelect(true);
      product.required = false; // part of the add-item row, not of the final submit
      var qty = h('input', { type: 'number', min: '0.01', step: '0.01', value: '1' });
      var price = h('input', { type: 'number', min: '0', step: '0.01' });
      var cartBox = h('div', {});
      var total = h('strong', {}, money(0));

      function redrawCart() {
        var sum = 0;
        var rows = cart.map(function (c, i) {
          var amount = Math.round(c.qty * c.price * 100) / 100;
          sum += amount;
          return [c.name, qtyFmt(c.qty), money(c.price), money(amount),
            h('button', { type: 'button', class: 'btn btn-small', onclick: function () { cart.splice(i, 1); redrawCart(); } }, 'Remove')];
        });
        total.textContent = money(sum);
        cartBox.replaceChildren(cart.length
          ? table(['Item', 'Qty (sqm)', 'Price / sqm', 'Amount', ''], rows, [1, 2, 3])
          : h('p', { class: 'empty' }, 'No items added yet.'));
      }

      function addItem() {
        var p = productById(product.value);
        var q = Math.round(parseFloat(qty.value) * 100) / 100;
        var pr = parseFloat(price.value);
        if (!p) { toast('Choose a product.', 'error'); return; }
        if (!(q > 0)) { toast('Enter a quantity greater than zero.', 'error'); return; }
        if (!(pr >= 0)) { toast('Enter the price per sqm.', 'error'); return; }
        var already = cart.filter(function (c) { return c.product_id === p.id; })
          .reduce(function (s, c) { return s + c.qty; }, 0);
        if (already + q > Number(p.stock_on_hand)) {
          toast('Only ' + qtyFmt(p.stock_on_hand) + ' sqm of ' + p.product_name + ' in stock.', 'error');
          return;
        }
        cart.push({ product_id: p.id, name: p.product_name, qty: q, price: pr });
        product.value = ''; qty.value = '1'; price.value = '';
        redrawCart();
        product.focus();
      }

      product.addEventListener('change', function () {
        var p = productById(product.value);
        price.value = p && Number(p.selling_price) > 0 ? p.selling_price : '';
      });
      [qty, price].forEach(function (el) {
        el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });
      });

      var form = h('form', { onsubmit: submitHandler(function () {
        if (!cart.length) throw new Error('Add at least one item to the sale.');
        var items = cart.map(function (c) { return { product_id: c.product_id, qty: c.qty, unit_price: c.price }; });
        return db.rpc('record_sale_receipt', {
          p_items: items, p_customer: customer.value, p_phone: phone.value, p_email: email.value
        }).then(must).then(function (id) {
          viewingReceipt = id;
          cart = [];
          saleDraft = { name: '', phone: '', email: '' };
        });
      }, 'Sale recorded. Receipt ready below.') },
        h('div', { class: 'form-grid' },
          field('Customer name (optional)', customer), field('Customer phone (for WhatsApp)', phone), field('Customer email', email)),
        h('h3', { style: 'margin-top:18px' }, 'Items'),
        h('div', { class: 'form-grid' },
          field('Product', product), field('Quantity (sqm)', qty), field('Price per sqm ($)', price),
          h('div', {}, h('button', { type: 'button', class: 'btn btn-small', onclick: addItem }, 'Add item'))),
        cartBox,
        h('div', { class: 'form-actions' },
          h('button', { type: 'submit', class: 'btn btn-primary' }, 'Complete sale & create receipt'),
          h('span', {}, 'Total: ', total))
      );
      redrawCart();

      var rows = history.map(function (r) {
        return [receiptNo(r.receipt_no), fmtDate(r.created_at), r.customer_name || '\u2014', money(r.total_amount),
          r.emailed_at ? h('span', { class: 'badge' }, 'Emailed') : '',
          h('button', { type: 'button', class: 'btn btn-small', onclick: function () {
            viewingReceipt = r.id; showTab('sales'); window.scrollTo(0, 0);
          } }, 'View')];
      });

      panel.replaceChildren(
        h('h2', {}, 'Sales'),
        open ? receiptCard(open) : null,
        card('New sale', form),
        card('Recent receipts', table(['Receipt', 'Date', 'Customer', 'Total', '', ''], rows, [3]))
      );
    });
  }

  // --------------------------------------------------------------- purchases

  function renderPurchases() {
    return Promise.all([
      loadProducts(),
      db.from('purchases').select('*, inventory(product_name)').order('created_at', { ascending: false }).limit(100)
    ]).then(function (res) {
      var history = must(res[1]);
      var product = productSelect(true);
      var qty = numberInput({ min: '0.01', step: '0.01', value: '1' });
      var cost = numberInput({ min: '0', step: '0.01' });
      var supplier = h('input', { type: 'text', maxlength: 120 });
      product.addEventListener('change', function () {
        var p = productById(product.value);
        cost.value = p ? p.unit_cost : '';
      });

      var form = h('form', { onsubmit: submitHandler(function () {
        return db.rpc('record_purchase', {
          p_product_id: product.value, p_qty: parseFloat(qty.value),
          p_unit_cost: parseFloat(cost.value), p_supplier: supplier.value
        }).then(must);
      }, 'Stock received') },
        h('div', { class: 'form-grid' },
          field('Product', product), field('Quantity received (sqm)', qty), field('Cost per sqm ($)', cost), field('Supplier (optional)', supplier)),
        h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Receive stock')),
        h('p', { class: 'hint' }, 'The product cost is updated to the average of existing stock and this delivery.')
      );

      panel.replaceChildren(
        h('h2', {}, 'Purchases'),
        card('Receive stock', form),
        card('Recent purchases', table(['Date', 'Product', 'Qty (sqm)', 'Cost / sqm', 'Total', 'Supplier'],
          history.map(function (p) {
            return [fmtDate(p.created_at), p.inventory ? p.inventory.product_name : '—', qtyFmt(p.qty_bought),
              money(p.unit_cost), money(p.total_cost), p.supplier || '—'];
          }), [2, 3, 4]))
      );
    });
  }

  // ------------------------------------------------------------- adjustments

  var ADJ_LABELS = {
    breakage: 'Breakage',
    loss: 'Loss / theft',
    'return': 'Customer return (back in stock)',
    manual_adjustment: 'Stock count correction (+/−)'
  };
  var ADJ_HINTS = {
    breakage: 'Removes stock and writes its cost off in the accounts.',
    loss: 'Removes stock and writes its cost off in the accounts.',
    'return': 'Adds stock back. Record any refund under Accounting as an expense.',
    manual_adjustment: 'Use a negative number to remove stock. No accounting entry is made.'
  };

  function renderAdjustments() {
    return Promise.all([
      loadProducts(),
      db.from('stock_adjustments').select('*, inventory(product_name)').order('created_at', { ascending: false }).limit(100)
    ]).then(function (res) {
      var history = must(res[1]);
      var product = productSelect(true);
      var type = h('select', { required: true }, Object.keys(ADJ_LABELS).map(function (k) { return h('option', { value: k }, ADJ_LABELS[k]); }));
      var qty = numberInput({ step: '0.01', value: '1' });
      var reason = h('input', { type: 'text', required: true, maxlength: 200, placeholder: 'What happened?' });
      var hint = h('p', { class: 'hint' }, ADJ_HINTS.breakage);
      type.addEventListener('change', function () { hint.textContent = ADJ_HINTS[type.value]; });

      var form = h('form', { onsubmit: submitHandler(function () {
        return db.rpc('record_adjustment', {
          p_product_id: product.value, p_type: type.value, p_qty: parseFloat(qty.value), p_reason: reason.value
        }).then(must);
      }, 'Adjustment recorded') },
        h('div', { class: 'form-grid' },
          field('Product', product), field('Type', type), field('Quantity (sqm)', qty), field('Reason', reason)),
        h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Record')),
        hint
      );

      panel.replaceChildren(
        h('h2', {}, 'Breakages & Loss'),
        card('Record a stock adjustment', form),
        card('Recent adjustments', table(['Date', 'Product', 'Type', 'Qty (sqm)', 'Reason'],
          history.map(function (a) {
            return [fmtDate(a.created_at), a.inventory ? a.inventory.product_name : '—',
              h('span', { class: 'badge ' + (a.adjustment_type === 'breakage' || a.adjustment_type === 'loss' ? 'bad' : '') }, ADJ_LABELS[a.adjustment_type] || a.adjustment_type),
              qtyFmt(a.qty), a.reason || '—'];
          }), [3]))
      );
    });
  }

  // -------------------------------------------------------------- accounting

  var range = null;

  function defaultRange() {
    var now = new Date();
    return { from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDay(now) };
  }

  function renderAccounting() {
    if (!range) range = defaultRange();
    var r = dayRange(range.from, range.to);

    var ledgerQuery = db.from('accounting_entries').select('*').order('created_at', { ascending: false }).limit(200);
    if (r.from) ledgerQuery = ledgerQuery.gte('created_at', r.from);
    if (r.to) ledgerQuery = ledgerQuery.lt('created_at', r.to);

    return Promise.all([
      db.rpc('accounting_report', { p_from: r.from, p_to: r.to }),
      ledgerQuery
    ]).then(function (res) {
      var rep = must(res[0])[0];
      var ledger = must(res[1]);

      var from = h('input', { type: 'date', value: range.from || '' });
      var to = h('input', { type: 'date', value: range.to || '' });
      function apply(f, t) { range = { from: f, to: t }; showTab('accounting'); }
      var now = new Date();
      var presets = h('div', { class: 'form-actions', style: 'margin:0' },
        h('button', { type: 'button', class: 'btn btn-small', onclick: function () { var d = defaultRange(); apply(d.from, d.to); } }, 'This month'),
        h('button', { type: 'button', class: 'btn btn-small', onclick: function () {
          apply(isoDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)), isoDay(new Date(now.getFullYear(), now.getMonth(), 0)));
        } }, 'Last month'),
        h('button', { type: 'button', class: 'btn btn-small', onclick: function () { apply(isoDay(new Date(now.getFullYear(), 0, 1)), isoDay(now)); } }, 'This year'),
        h('button', { type: 'button', class: 'btn btn-small', onclick: function () { apply('', ''); } }, 'All time'));

      var filter = h('form', { class: 'range', onsubmit: function (e) { e.preventDefault(); apply(from.value, to.value); } },
        field('From', from), field('To', to),
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Apply'), presets);

      function line(label, amount, opts) {
        var cells = [label, money(amount)];
        if (opts && opts.total) cells.rowClass = 'total';
        return cells;
      }
      var net = Number(rep.net_profit);
      var pnl = table(['Profit & loss', 'Amount'], [
        line('Sales revenue', rep.revenue_total),
        line('Less: cost of goods sold', -rep.cogs_total),
        line('Less: breakages and losses', -rep.writeoffs_total),
        line('Gross profit', rep.gross_profit, { total: true }),
        line('Less: expenses', -rep.expenses_total),
        line('Plus: other income', rep.income_total),
        line('Net profit', net, { total: true })
      ], [1]);

      var kind = h('select', { required: true }, h('option', { value: 'expense' }, 'Expense (rent, transport, wages…)'), h('option', { value: 'income' }, 'Other income'));
      var amount = numberInput({ min: '0.01', step: '0.01' });
      var desc = h('input', { type: 'text', required: true, maxlength: 200 });
      var entryForm = h('form', { onsubmit: submitHandler(function () {
        return db.rpc('record_expense', { p_kind: kind.value, p_amount: parseFloat(amount.value), p_description: desc.value }).then(must);
      }, 'Entry recorded') },
        h('div', { class: 'form-grid' }, field('Type', kind), field('Amount ($)', amount), field('Description', desc)),
        h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Add entry'))
      );

      panel.replaceChildren(
        h('h2', {}, 'Accounting'),
        filter,
        card('', pnl, h('p', { class: 'hint' }, 'Stock bought in this period: ' + money(rep.purchases_total) + ' (cash spent; it becomes cost of goods sold when sold).')),
        card('Add expense or income', entryForm),
        card('Ledger (latest 200 in period)', table(['Date', 'Type', 'Description', 'Amount'],
          ledger.map(function (l) {
            return [fmtDate(l.created_at), l.entry_type.replace('_', ' '), l.description || '—',
              h('span', { class: Number(l.amount) < 0 ? 'neg' : 'pos' }, money(l.amount))];
          }), [3]))
      );
    });
  }

  // ------------------------------------------------------------------- leads

  var replyingTo = null;

  var INQUIRY_LABELS = {
    'clear-float': 'clear float glass', reflective: 'reflective glass', mirror: 'mirror glass',
    frosted: 'frosted glass', tinted: 'tinted glass', laminated: 'laminated glass',
    patterned: 'patterned glass', bulk: 'bulk order', other: 'glass'
  };

  function sendReply(lead, subject, message) {
    return invokeFn('reply-lead', { leadId: lead.id, subject: subject, message: message });
  }

  // Calls an admin-only edge function and turns its JSON error into a thrown Error.
  function invokeFn(name, body) {
    return db.functions.invoke(name, { body: body }).then(function (res) {
      if (!res.error) return res.data;
      var ctx = res.error.context;
      if (ctx && typeof ctx.json === 'function') {
        return ctx.json().then(function (b) { throw new Error((b && b.error) || 'The request failed.'); },
          function () { throw new Error('The request failed.'); });
      }
      throw new Error(res.error.message || 'The request failed.');
    });
  }

  function replyCard(lead, replies) {
    var subject = h('input', { type: 'text', required: true, maxlength: 200,
      value: 'Re: Your Tacoa enquiry about ' + (INQUIRY_LABELS[lead.inquiry_type] || 'glass') });
    var message = h('textarea', { required: true, rows: '9', maxlength: 10000 });
    message.value = 'Hi ' + lead.first_name + ',\n\nThank you for contacting Tacoa General Trading.\n\n\n\nKind regards,\nTacoa General Trading\n+263 77 772 6221\ninfo@tacoatrading.com';

    var form = h('form', { onsubmit: submitHandler(function () {
      return sendReply(lead, subject.value.trim(), message.value.trim()).then(function () { replyingTo = null; });
    }, 'Reply sent') },
      h('div', { class: 'form-grid' }, field('To', h('input', { type: 'text', value: lead.email, readonly: true })), field('Subject', subject)),
      field('Message', message),
      h('div', { class: 'form-actions' },
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send reply'),
        h('button', { type: 'button', class: 'btn btn-small', onclick: function () { replyingTo = null; showTab('leads'); } }, 'Cancel')),
      h('p', { class: 'hint' }, 'Sent from info@tacoatrading.com. Customer replies arrive in that mailbox, and a copy of this message is sent there too.')
    );

    return card('Reply to ' + lead.first_name + ' ' + lead.last_name,
      h('div', { class: 'muted' }, 'Their message:'),
      h('div', { class: 'msg-cell' }, lead.message),
      replies.length ? h('div', {},
        h('p', { class: 'muted' }, 'Already sent:'),
        replies.map(function (r) {
          return h('div', { class: 'msg-cell' }, h('strong', {}, fmtDate(r.created_at) + ' \u2014 ' + r.subject), '\n', r.body, '\n\n');
        })) : null,
      form);
  }

  function renderLeads() {
    function quoteBtn(l) {
      return h('div', {}, h('button', { type: 'button', class: 'btn btn-small', onclick: function () {
        resetQuoteDraft();
        quoteDraft.name = (l.first_name + ' ' + l.last_name).trim();
        quoteDraft.phone = l.phone || '';
        quoteDraft.email = l.email || '';
        quoteDraft.leadId = l.id;
        quoteDraft.leadMessage = l.message || '';
        viewingQuote = null;
        showTab('quotes'); window.scrollTo(0, 0);
      } }, 'Create quote'));
    }

    return Promise.all([
      db.from('leads').select('*').order('created_at', { ascending: false }).limit(200),
      db.from('lead_replies').select('lead_id, subject, body, created_at').order('created_at', { ascending: true })
    ]).then(function (res) {
      var leads = must(res[0]);
      var allReplies = res[1].error ? [] : res[1].data;
      var byLead = {};
      allReplies.forEach(function (r) { (byLead[r.lead_id] = byLead[r.lead_id] || []).push(r); });

      var rows = leads.map(function (l) {
        var sent = byLead[l.id] || [];
        var status = h('select', { 'aria-label': 'Status', onchange: function (e) {
          db.from('leads').update({ status: e.target.value }).eq('id', l.id).then(function (res) {
            if (res.error) toast(res.error.message, 'error'); else toast('Status updated', 'ok');
          });
        } }, ['new', 'contacted', 'won', 'lost'].map(function (s) {
          return h('option', { value: s, selected: s === l.status }, s);
        }));
        var phone = String(l.phone || '').replace(/[^\d+]/g, '');
        return [
          fmtDate(l.created_at),
          h('div', {}, h('strong', {}, l.first_name + ' ' + l.last_name), h('div', { class: 'muted' }, l.location || '')),
          h('div', {},
            phone ? h('a', { href: 'tel:' + phone }, l.phone) : l.phone,
            l.email ? h('div', {}, l.email) : null),
          l.inquiry_type,
          h('div', { class: 'msg-cell' }, l.message),
          status,
          l.email
            ? h('div', {},
                h('button', { type: 'button', class: 'btn btn-small', onclick: function () {
                  replyingTo = l.id; showTab('leads'); window.scrollTo(0, 0);
                } }, 'Reply'),
                sent.length ? h('div', { class: 'muted' }, sent.length + ' sent') : null,
                quoteBtn(l))
            : h('div', {}, h('span', { class: 'muted' }, 'No email'), quoteBtn(l))
        ];
      });

      var target = replyingTo ? leads.filter(function (l) { return l.id === replyingTo; })[0] : null;
      panel.replaceChildren(
        h('h2', {}, 'Enquiries'),
        target ? replyCard(target, byLead[target.id] || []) : null,
        card('', table(['Received', 'Name', 'Contact', 'Type', 'Message', 'Status', 'Actions'], rows))
      );
    });
  }

  // ------------------------------------------------------------------ quotes
  // A quote never changes stock or the accounts. Accepting one records it as a normal sale/receipt.

  var quoteItems = [];      // [{ product_id, name, qty, price }]
  var viewingQuote = null;
  var quoteDraft = { name: '', phone: '', email: '', days: '14', notes: '', leadId: null, leadMessage: '' };

  function resetQuoteDraft() {
    quoteItems = [];
    quoteDraft = { name: '', phone: '', email: '', days: '14', notes: '', leadId: null, leadMessage: '' };
  }

  function quoteNo(n) { return 'QUO-' + String(n).padStart(6, '0'); }
  function validText(d) { return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { dateStyle: 'long' }); }
  function isExpired(q) { return q.status === 'open' && q.valid_until < isoDay(new Date()); }

  function fetchQuote(id) {
    return db.from('quotes')
      .select('*, quote_items(description, qty, unit_price, total_amount)')
      .eq('id', id).single().then(must);
  }

  function quoteSpec(q) {
    var f = firstName(q.customer_name);
    var footer = [];
    if (q.notes) footer.push('Notes: ' + q.notes);
    footer.push('Prices are subject to stock availability. To go ahead, reply to this quote or call us on +263 77 772 6221.');
    return {
      title: 'QUOTATION',
      number: quoteNo(q.quote_no),
      dateLine: 'Valid until ' + validText(q.valid_until),
      who: [q.customer_name || 'Customer', q.customer_phone, q.customer_email].filter(Boolean),
      lines: (q.quote_items || []).map(function (i) {
        return { name: i.description, qty: i.qty, price: i.unit_price, amount: i.total_amount };
      }),
      total: q.total_amount,
      footer: footer,
      fileName: 'Quote-' + quoteNo(q.quote_no) + '.pdf',
      phone: q.customer_phone,
      whatsappText: (f ? 'Hi ' + f + ', here' : 'Here') + ' is your quotation ' + quoteNo(q.quote_no) +
        ' from Tacoa General Trading. Total: ' + money(q.total_amount) + ', valid until ' + validText(q.valid_until) + '.'
    };
  }

  function quoteStatusBadge(q) {
    if (isExpired(q)) return h('span', { class: 'badge warn' }, 'Expired');
    return h('span', { class: 'badge ' + (q.status === 'declined' ? 'bad' : '') }, q.status);
  }

  function quoteCard(q) {
    var spec = quoteSpec(q);
    var isOpen = q.status === 'open';
    var rows = (q.quote_items || []).map(function (i) {
      return [i.description, qtyFmt(i.qty), money(i.unit_price), money(i.total_amount)];
    });
    var totalRow = ['Total', '', '', money(q.total_amount)];
    totalRow.rowClass = 'total';
    rows.push(totalRow);

    var emailIn = h('input', { type: 'email', maxlength: 254, placeholder: 'customer@example.com', value: q.customer_email || '' });
    var sendBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: function () {
      var to = emailIn.value.trim();
      if (!to || !emailIn.checkValidity()) { toast('Enter a valid email address.', 'error'); return; }
      sendBtn.disabled = true;
      var b64 = buildPdf(spec).output('datauristring').split(',')[1];
      invokeFn('send-quote', { quoteId: q.id, to: to, pdfBase64: b64 }).then(function () {
        toast('Quote emailed to ' + to, 'ok');
        sendBtn.textContent = 'Email again';
      }).catch(function (err) {
        toast((err && err.message) || 'The email could not be sent.', 'error');
      }).then(function () { sendBtn.disabled = false; });
    } }, q.emailed_at ? 'Email again' : 'Email quote');

    var acceptBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: function () {
      if (!window.confirm('Record this quote as paid? Stock will be removed and the sale added to the accounts.')) return;
      acceptBtn.disabled = true;
      db.rpc('accept_quote', { p_quote_id: q.id }).then(must).then(function (receiptId) {
        viewingQuote = null;
        viewingReceipt = receiptId;
        toast('Sale recorded. Receipt ready.', 'ok');
        return showTab('sales').then(function () { window.scrollTo(0, 0); });
      }).catch(function (err) {
        toast((err && err.message) || 'Could not record the sale.', 'error');
        acceptBtn.disabled = false;
      });
    } }, 'Customer paid: record sale');

    var declineBtn = h('button', { type: 'button', class: 'btn btn-small', onclick: function () {
      if (!window.confirm('Mark this quote as declined?')) return;
      db.rpc('decline_quote', { p_quote_id: q.id }).then(must).then(function () {
        toast('Quote marked declined', 'ok');
        return showTab('quotes');
      }).catch(function (err) { toast((err && err.message) || 'Could not update the quote.', 'error'); });
    } }, 'Mark declined');

    return card('Quote ' + quoteNo(q.quote_no),
      h('p', { class: 'muted' }, fmtDate(q.created_at) + ' \u00b7 ' + (q.customer_name || 'Customer') +
        (q.customer_phone ? ' \u00b7 ' + q.customer_phone : '') + ' \u00b7 valid until ' + validText(q.valid_until) + ' \u00b7 ',
        quoteStatusBadge(q)),
      table(['Item', 'Qty (sqm)', 'Price / sqm', 'Amount'], rows, [1, 2, 3]),
      q.notes ? h('p', { class: 'msg-cell' }, 'Notes: ' + q.notes) : null,
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { buildPdf(spec).save(spec.fileName); } }, 'Download PDF'),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { shareOnWhatsApp(spec); } }, 'Send on WhatsApp'),
        h('button', { type: 'button', class: 'btn btn-small', onclick: function () { viewingQuote = null; showTab('quotes'); } }, 'Close')),
      isOpen ? h('div', { class: 'form-grid', style: 'margin-top:14px' }, field('Email to', emailIn), h('div', {}, sendBtn)) : null,
      q.emailed_at ? h('p', { class: 'hint' }, 'Last emailed ' + fmtDate(q.emailed_at) + '.') : null,
      isOpen ? h('div', { class: 'form-actions' }, acceptBtn, declineBtn) : null,
      isOpen ? h('p', { class: 'hint' }, 'Nothing is taken out of stock until you press "Customer paid: record sale".') : null,
      q.status === 'accepted' && q.receipt_id ? h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn btn-small', onclick: function () {
          viewingReceipt = q.receipt_id; showTab('sales'); window.scrollTo(0, 0);
        } }, 'View receipt')) : null);
  }

  function renderQuotes() {
    return Promise.all([
      loadProducts(),
      db.from('quotes').select('id, quote_no, customer_name, total_amount, valid_until, status, created_at, emailed_at')
        .order('created_at', { ascending: false }).limit(100),
      viewingQuote ? fetchQuote(viewingQuote) : Promise.resolve(null)
    ]).then(function (res) {
      var history = must(res[1]);
      var open = res[2];

      var customer = h('input', { type: 'text', maxlength: 120, value: quoteDraft.name });
      var phone = h('input', { type: 'tel', maxlength: 40, placeholder: '0777 123 456', value: quoteDraft.phone });
      var email = h('input', { type: 'email', maxlength: 254, placeholder: 'customer@example.com', value: quoteDraft.email });
      var days = h('input', { type: 'number', min: '1', max: '365', step: '1', required: true, value: quoteDraft.days });
      var notes = h('textarea', { rows: '3', maxlength: 1000, placeholder: 'Delivery, cutting, payment terms\u2026' });
      notes.value = quoteDraft.notes;
      customer.addEventListener('input', function () { quoteDraft.name = customer.value; });
      phone.addEventListener('input', function () { quoteDraft.phone = phone.value; });
      email.addEventListener('input', function () { quoteDraft.email = email.value; });
      days.addEventListener('input', function () { quoteDraft.days = days.value; });
      notes.addEventListener('input', function () { quoteDraft.notes = notes.value; });

      var product = productSelect(true);
      product.required = false; // part of the add-item row, not of the final submit
      var qty = h('input', { type: 'number', min: '0.01', step: '0.01', value: '1' });
      var price = h('input', { type: 'number', min: '0', step: '0.01' });
      var itemsBox = h('div', {});
      var total = h('strong', {}, money(0));

      function redraw() {
        var sum = 0;
        var rows = quoteItems.map(function (c, i) {
          var amount = Math.round(c.qty * c.price * 100) / 100;
          sum += amount;
          return [c.name, qtyFmt(c.qty), money(c.price), money(amount),
            h('button', { type: 'button', class: 'btn btn-small', onclick: function () { quoteItems.splice(i, 1); redraw(); } }, 'Remove')];
        });
        total.textContent = money(sum);
        itemsBox.replaceChildren(quoteItems.length
          ? table(['Item', 'Qty (sqm)', 'Price / sqm', 'Amount', ''], rows, [1, 2, 3])
          : h('p', { class: 'empty' }, 'No items added yet.'));
      }

      function addItem() {
        var p = productById(product.value);
        var q = Math.round(parseFloat(qty.value) * 100) / 100;
        var pr = parseFloat(price.value);
        if (!p) { toast('Choose a product.', 'error'); return; }
        if (!(q > 0)) { toast('Enter a quantity greater than zero.', 'error'); return; }
        if (!(pr >= 0)) { toast('Enter the price per sqm.', 'error'); return; }
        quoteItems.push({ product_id: p.id, name: p.product_name, qty: q, price: pr });
        product.value = ''; qty.value = '1'; price.value = '';
        redraw();
        product.focus();
      }

      product.addEventListener('change', function () {
        var p = productById(product.value);
        price.value = p && Number(p.selling_price) > 0 ? p.selling_price : '';
      });
      [qty, price].forEach(function (el) {
        el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });
      });

      var form = h('form', { onsubmit: submitHandler(function () {
        if (!quoteItems.length) throw new Error('Add at least one item to the quote.');
        var items = quoteItems.map(function (c) { return { product_id: c.product_id, qty: c.qty, unit_price: c.price }; });
        return db.rpc('create_quote', {
          p_items: items, p_customer: customer.value, p_phone: phone.value, p_email: email.value,
          p_valid_days: parseInt(days.value, 10), p_notes: notes.value, p_lead_id: quoteDraft.leadId
        }).then(must).then(function (id) {
          viewingQuote = id;
          resetQuoteDraft();
        });
      }, 'Quote created. Ready to send below.') },
        quoteDraft.leadMessage ? h('div', {},
          h('p', { class: 'muted' }, 'Their enquiry:'),
          h('div', { class: 'msg-cell' }, quoteDraft.leadMessage)) : null,
        h('div', { class: 'form-grid' },
          field('Customer name', customer), field('Customer phone (for WhatsApp)', phone), field('Customer email', email),
          field('Valid for (days)', days)),
        h('h3', { style: 'margin-top:18px' }, 'Items'),
        h('div', { class: 'form-grid' },
          field('Product', product), field('Quantity (sqm)', qty), field('Price per sqm ($)', price),
          h('div', {}, h('button', { type: 'button', class: 'btn btn-small', onclick: addItem }, 'Add item'))),
        itemsBox,
        field('Notes (shown on the quote)', notes),
        h('div', { class: 'form-actions' },
          h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create quote'),
          h('span', {}, 'Total: ', total),
          quoteDraft.leadId || quoteItems.length || quoteDraft.name
            ? h('button', { type: 'button', class: 'btn btn-small', onclick: function () { resetQuoteDraft(); showTab('quotes'); } }, 'Clear form')
            : null)
      );
      redraw();

      var rows = history.map(function (q) {
        return [quoteNo(q.quote_no), fmtDate(q.created_at), q.customer_name || '\u2014', money(q.total_amount),
          validText(q.valid_until), quoteStatusBadge(q),
          h('button', { type: 'button', class: 'btn btn-small', onclick: function () {
            viewingQuote = q.id; showTab('quotes'); window.scrollTo(0, 0);
          } }, 'View')];
      });

      panel.replaceChildren(
        h('h2', {}, 'Quotes'),
        open ? quoteCard(open) : null,
        card('New quote', form),
        card('Recent quotes', table(['Quote', 'Date', 'Customer', 'Total', 'Valid until', 'Status', ''], rows, [3]))
      );
    });
  }

  // ----------------------------------------------------------------- routing

  var TABS = {
    overview: renderOverview,
    inventory: renderInventory,
    sales: renderSales,
    quotes: renderQuotes,
    purchases: renderPurchases,
    adjustments: renderAdjustments,
    accounting: renderAccounting,
    leads: renderLeads
  };

  function showTab(name) {
    if (!TABS[name]) name = 'overview';
    current = name;
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    return TABS[name]().catch(function (err) {
      panel.replaceChildren(h('p', { class: 'form-error' }, 'Could not load this section: ' + ((err && err.message) || 'unknown error')));
    });
  }

  document.getElementById('tabs').addEventListener('click', function (e) {
    var tab = e.target.getAttribute && e.target.getAttribute('data-tab');
    if (tab) { editing = null; showTab(tab); }
  });

  // -------------------------------------------------------------------- auth

  var loginError = document.getElementById('login-error');

  function showLogin(message) {
    appView.hidden = true;
    loginView.hidden = false;
    loginError.hidden = !message;
    loginError.textContent = message || '';
  }

  function enter() {
    return db.rpc('is_admin').then(function (res) {
      if (res.error || res.data !== true) {
        return db.auth.signOut().then(function () {
          showLogin('This account is not authorised for the admin area.');
        });
      }
      loginView.hidden = true;
      appView.hidden = false;
      return showTab(location.hash.slice(1) || 'overview');
    });
  }

  document.getElementById('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = e.currentTarget.querySelector('button[type=submit]');
    btn.disabled = true;
    db.auth.signInWithPassword({
      email: document.getElementById('login-email').value.trim(),
      password: document.getElementById('login-password').value
    }).then(function (res) {
      document.getElementById('login-password').value = '';
      if (res.error) { showLogin('Invalid email or password.'); return; }
      return enter();
    }).catch(function () {
      showLogin('Could not sign in. Check your connection and try again.');
    }).then(function () { btn.disabled = false; });
  });

  document.getElementById('logout').addEventListener('click', function () {
    db.auth.signOut().then(function () { products = []; showLogin(''); });
  });

  db.auth.getSession().then(function (res) {
    if (res.data && res.data.session) return enter();
    showLogin('');
  });
})();
