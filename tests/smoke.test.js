const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function makeDemo() {
  const listeners = {};
  const toasts = [];
  const nav = ['dashboard', 'inventory', 'inbound', 'outbound', 'stocktake', 'reports', 'settings']
    .map(page => ({dataset: {page}, classList: {toggle() {}}}));
  const content = {innerHTML: '', addEventListener(type, fn) { listeners[`content:${type}`] = fn; }};
  const values = {};
  const node = () => ({textContent: '', innerHTML: '', hidden: false, addEventListener(type, fn) { listeners[type] = fn; }});
  const nodes = new Map([
    ['#page-content', content], ['#today-date', node()], ['#breadcrumb-current', node()],
    ['#action-dialog', {open: false, showModal() { this.open = true; }, close() { this.open = false; }}],
    ['#action-form', node()], ['#dialog-body', node()], ['#dialog-title', node()],
    ['#dialog-submit', node()], ['#dialog-eyebrow', node()],
    ['#toast-region', {append(element) { toasts.push(element.textContent); }}]
  ]);
  const document = {
    querySelector(selector) { return nodes.get(selector) || null; },
    querySelectorAll(selector) { return selector === '[data-page]' ? nav : []; },
    addEventListener(type, fn) { listeners[`document:${type}`] = fn; },
    createElement() { return {className: '', textContent: ''}; }
  };
  class MockFormData {
    constructor() { this.entries = () => Object.entries(values); }
  }
  const context = {document, FormData: MockFormData, setTimeout() {}, URL, Blob, Intl, Date, Number, String, Object};
  vm.runInNewContext(appSource, context, {filename: 'app.js'});
  return {
    content,
    toasts,
    dialog: nodes.get('#action-dialog'),
    body: nodes.get('#dialog-body'),
    title: nodes.get('#dialog-title'),
    submitButton: nodes.get('#dialog-submit'),
    setValues(next) { Object.assign(values, next); },
    clickPage(page) {
      listeners['document:click']({preventDefault() {}, target: {closest(selector) {
        return selector === '[data-page]' ? {dataset: {page}} : null;
      }}});
    },
    clickAction(action, id) {
      listeners['document:click']({preventDefault() {}, target: {closest(selector) {
        return selector === '[data-action]' ? {dataset: {action, id}} : null;
      }}});
    },
    submit() { listeners.submit({preventDefault() {}, currentTarget: {}}); }
  };
}

test('demo provides its local assets and core navigation', () => {
  assert.match(html, /href="styles\.css"/);
  assert.match(html, /src="app\.js"/);
  for (const page of ['dashboard', 'inventory', 'inbound', 'outbound', 'stocktake', 'reports']) {
    assert.match(html, new RegExp(`data-page="${page}"`));
  }
  const demo = makeDemo();
  assert.match(demo.content.innerHTML, /庫存趨勢/);
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /庫存明細/);
  assert.match(demo.content.innerHTML, /去骨雞腿排/);
  demo.clickAction('detail', 'LOT-260912-04');
  assert.equal(demo.title.textContent, '去骨雞腿排');
  demo.clickAction('inbound');
  assert.equal(demo.submitButton.hidden, false, 'action button should return after opening a read-only detail dialog');
  assert.match(demo.body.innerHTML, /name="temp" type="number" value="-20\.5"\s+required/, 'negative receiving temperature must be accepted');
});

test('outbound guards stock, and inbound, scrap, and count update simulated inventory', () => {
  const demo = makeDemo();

  demo.clickAction('outbound');
  assert.match(demo.body.innerHTML, /揀貨商品／批次/);
  assert.ok(demo.body.innerHTML.indexOf('冷凍藍莓') < demo.body.innerHTML.indexOf('挪威鮭魚切片'), 'outbound options should follow FEFO order');
  demo.setValues({lot: 'LOT-260915-02', qty: '999', partner: '測試客戶', operator: '林志明'});
  demo.submit();
  assert.ok(demo.toasts.at(-1).includes('可用庫存不足'));
  assert.equal(demo.dialog.open, true);

  demo.setValues({lot: 'LOT-260915-02', qty: '30', partner: '測試客戶', operator: '林志明'});
  demo.submit();
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /可用庫存 1,605 箱/);

  demo.clickAction('inbound');
  demo.setValues({name: '測試新品', category: '肉品', qty: '10', batch: 'T260929-A', expiry: '2027-01-01', location: 'B-02-01', partner: '測試供應商', temp: '-20.5', reason: ''});
  demo.submit();
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /測試新品/);
  assert.match(demo.content.innerHTML, /可用庫存 1,615 箱/);

  demo.clickAction('scrap');
  demo.setValues({lot: 'LOT-260901-07', qty: '6', reason: '腐爛／變質', operator: '林志明'});
  demo.submit();
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /可用庫存 1,609 箱/);

  demo.clickAction('stocktake');
  demo.setValues({lot: 'LOT-260901-07', qty: '80', reason: '例行盤點差異', operator: '林志明'});
  demo.submit();
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /可用庫存 1,603 箱/);
  assert.ok(demo.toasts.at(-1).includes('盤點已確認'));
});
