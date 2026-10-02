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
          p.product_name + (showStock ? ' (' + p.stock_on_hand + ' in stock)' : ''));
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
        stockValue += p.stock_on_hand * Number(p.unit_cost);
        retailValue += p.stock_on_hand * Number(p.selling_price);
      });
      var low = products.filter(function (p) { return p.stock_on_hand <= p.reorder_level; });
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
          table(['Product', 'In stock', 'Reorder level'],
            low.map(function (p) {
              return [p.product_name, h('span', { class: 'badge ' + (p.stock_on_hand === 0 ? 'bad' : 'warn') }, p.stock_on_hand), String(p.reorder_level)];
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
      var reorder = numberInput({ min: '0', step: '1', value: e ? e.reorder_level : '0' });
      var opening = e ? null : numberInput({ min: '0', step: '1', value: '0' });

      var form = h('form', { onsubmit: submitHandler(function () {
        var row = {
          product_name: name.value.trim(),
          category: category.value.trim(),
          unit_cost: parseFloat(cost.value),
          selling_price: parseFloat(price.value),
          reorder_level: parseInt(reorder.value, 10)
        };
        if (e) {
          return db.from('inventory').update(Object.assign({ updated_at: new Date().toISOString() }, row)).eq('id', e.id).then(function (r) {
            must(r);
            editing = null;
          });
        }
        return db.from('inventory').insert([row]).select().single().then(function (r) {
          var created = must(r);
          var qty = parseInt(opening.value, 10) || 0;
          if (qty > 0) {
            return db.rpc('record_adjustment', {
              p_product_id: created.id, p_type: 'manual_adjustment', p_qty: qty, p_reason: 'Opening stock'
            }).then(must);
          }
        });
      }, e ? 'Product updated' : 'Product added') },
        h('div', { class: 'form-grid' },
          field('Product name', name), field('Category', category), datalist,
          field('Cost per unit ($)', cost), field('Selling price ($)', price),
          field('Reorder level', reorder), opening ? field('Opening stock', opening) : null),
        h('div', { class: 'form-actions' },
          h('button', { type: 'submit', class: 'btn btn-primary' }, e ? 'Save changes' : 'Add product'),
          e ? h('button', { type: 'button', class: 'btn btn-small', onclick: function () { editing = null; showTab('inventory'); } }, 'Cancel') : null),
        h('p', { class: 'hint' }, 'Stock quantities change only through Purchases, Sales and Breakages & Loss, so the books always match the shelf.')
      );

      var rows = products.map(function (p) {
        var margin = Number(p.selling_price) > 0 ? ((p.selling_price - p.unit_cost) / p.selling_price) * 100 : 0;
        var low = p.stock_on_hand <= p.reorder_level;
        return [
          p.product_name, p.category,
          h('span', { class: 'badge ' + (p.stock_on_hand === 0 ? 'bad' : low ? 'warn' : '') }, p.stock_on_hand),
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
        card('Products', table(['Product', 'Category', 'In stock', 'Cost', 'Price', 'Margin', 'Stock value', ''], rows, [2, 3, 4, 5, 6]))
      );
    });
  }

  // ------------------------------------------------------------------- sales

  function renderSales() {
    return Promise.all([
      loadProducts(),
      db.from('sales').select('*, inventory(product_name)').order('created_at', { ascending: false }).limit(100)
    ]).then(function (res) {
      var history = must(res[1]);
      var product = productSelect(true);
      var qty = numberInput({ min: '1', step: '1', value: '1' });
      var price = numberInput({ min: '0', step: '0.01' });
      var customer = h('input', { type: 'text', maxlength: 120 });
      var total = h('strong', {}, money(0));

      function recalc() { total.textContent = money((parseInt(qty.value, 10) || 0) * (parseFloat(price.value) || 0)); }
      product.addEventListener('change', function () {
        var p = productById(product.value);
        price.value = p ? p.selling_price : '';
        recalc();
      });
      qty.addEventListener('input', recalc);
      price.addEventListener('input', recalc);

      var form = h('form', { onsubmit: submitHandler(function () {
        return db.rpc('record_sale', {
          p_product_id: product.value, p_qty: parseInt(qty.value, 10),
          p_unit_price: parseFloat(price.value), p_customer: customer.value
        }).then(must);
      }, 'Sale recorded') },
        h('div', { class: 'form-grid' },
          field('Product', product), field('Quantity', qty), field('Unit price ($)', price), field('Customer (optional)', customer)),
        h('div', { class: 'form-actions' },
          h('button', { type: 'submit', class: 'btn btn-primary' }, 'Record sale'),
          h('span', {}, 'Total: ', total))
      );

      panel.replaceChildren(
        h('h2', {}, 'Sales'),
        card('Record a sale', form),
        card('Recent sales', table(['Date', 'Product', 'Qty', 'Unit price', 'Total', 'Customer'],
          history.map(function (s) {
            return [fmtDate(s.created_at), s.inventory ? s.inventory.product_name : '—', String(s.qty_sold),
              money(s.unit_price), money(s.total_amount), s.customer_name || '—'];
          }), [2, 3, 4]))
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
      var qty = numberInput({ min: '1', step: '1', value: '1' });
      var cost = numberInput({ min: '0', step: '0.01' });
      var supplier = h('input', { type: 'text', maxlength: 120 });
      product.addEventListener('change', function () {
        var p = productById(product.value);
        cost.value = p ? p.unit_cost : '';
      });

      var form = h('form', { onsubmit: submitHandler(function () {
        return db.rpc('record_purchase', {
          p_product_id: product.value, p_qty: parseInt(qty.value, 10),
          p_unit_cost: parseFloat(cost.value), p_supplier: supplier.value
        }).then(must);
      }, 'Stock received') },
        h('div', { class: 'form-grid' },
          field('Product', product), field('Quantity received', qty), field('Cost per unit ($)', cost), field('Supplier (optional)', supplier)),
        h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Receive stock')),
        h('p', { class: 'hint' }, 'The product cost is updated to the average of existing stock and this delivery.')
      );

      panel.replaceChildren(
        h('h2', {}, 'Purchases'),
        card('Receive stock', form),
        card('Recent purchases', table(['Date', 'Product', 'Qty', 'Unit cost', 'Total', 'Supplier'],
          history.map(function (p) {
            return [fmtDate(p.created_at), p.inventory ? p.inventory.product_name : '—', String(p.qty_bought),
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
      var qty = numberInput({ step: '1', value: '1' });
      var reason = h('input', { type: 'text', required: true, maxlength: 200, placeholder: 'What happened?' });
      var hint = h('p', { class: 'hint' }, ADJ_HINTS.breakage);
      type.addEventListener('change', function () { hint.textContent = ADJ_HINTS[type.value]; });

      var form = h('form', { onsubmit: submitHandler(function () {
        return db.rpc('record_adjustment', {
          p_product_id: product.value, p_type: type.value, p_qty: parseInt(qty.value, 10), p_reason: reason.value
        }).then(must);
      }, 'Adjustment recorded') },
        h('div', { class: 'form-grid' },
          field('Product', product), field('Type', type), field('Quantity', qty), field('Reason', reason)),
        h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Record')),
        hint
      );

      panel.replaceChildren(
        h('h2', {}, 'Breakages & Loss'),
        card('Record a stock adjustment', form),
        card('Recent adjustments', table(['Date', 'Product', 'Type', 'Qty', 'Reason'],
          history.map(function (a) {
            return [fmtDate(a.created_at), a.inventory ? a.inventory.product_name : '—',
              h('span', { class: 'badge ' + (a.adjustment_type === 'breakage' || a.adjustment_type === 'loss' ? 'bad' : '') }, ADJ_LABELS[a.adjustment_type] || a.adjustment_type),
              String(a.qty), a.reason || '—'];
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

  function renderLeads() {
    return db.from('leads').select('*').order('created_at', { ascending: false }).limit(200).then(function (r) {
      var leads = must(r);
      var rows = leads.map(function (l) {
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
            l.email ? h('div', {}, h('a', { href: 'mailto:' + encodeURIComponent(l.email) }, l.email)) : null),
          l.inquiry_type,
          h('div', { class: 'msg-cell' }, l.message),
          status
        ];
      });
      panel.replaceChildren(
        h('h2', {}, 'Enquiries'),
        card('', table(['Received', 'Name', 'Contact', 'Type', 'Message', 'Status'], rows))
      );
    });
  }

  // ----------------------------------------------------------------- routing

  var TABS = {
    overview: renderOverview,
    inventory: renderInventory,
    sales: renderSales,
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
