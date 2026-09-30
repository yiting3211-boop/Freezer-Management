const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Inventory = require('../inventory.js');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const technicalPlan = fs.readFileSync(path.join(root, 'docs', '技術方案.md'), 'utf8');

test('technical plan maps the MVP requirements to an implementable stack', () => {
  for (const technology of ['Vue 3', 'TypeScript', 'Vite', 'NestJS', 'PostgreSQL', 'Prisma', 'Docker Compose']) {
    assert.ok(technicalPlan.includes(technology), `technical plan should include ${technology}`);
  }
  for (const requirement of ['FEFO', '庫存異動', '盤點差異', '報廢', 'CSV', '人工登記']) {
    assert.ok(technicalPlan.includes(requirement), `technical plan should address ${requirement}`);
  }
  assert.match(technicalPlan, /記憶體中/);
  assert.match(technicalPlan, /並行保護/);
});

function makeDemo(storage) {
  const listeners = {};
  const toasts = [];
  const nav = ['dashboard', 'inventory', 'inbound', 'outbound', 'stocktake', 'reports', 'settings']
    .map(page => ({dataset: {page}, classList: {toggle() {}}}));
  const content = {innerHTML: '', addEventListener(type, fn) { (listeners[`content:${type}`] ||= []).push(fn); }};
  const values = {};
  const filterValues = {};
  const stockTable = {innerHTML: ''};
  const node = () => ({textContent: '', innerHTML: '', hidden: false, addEventListener(type, fn) { listeners[type] = fn; }});
  const nodes = new Map([
    ['#page-content', content], ['#today-date', node()], ['#breadcrumb-current', node()], ['#top-warehouse', node()],
    ['#action-dialog', {open: false, showModal() { this.open = true; }, close() { this.open = false; }}],
    ['#action-form', node()], ['#dialog-body', node()], ['#dialog-title', node()],
    ['#dialog-submit', node()], ['#dialog-eyebrow', node()],
    ['#toast-region', {append(element) { toasts.push(element.textContent); }}]
  ]);
  nodes.set('#stock-table-body', stockTable);
  const document = {
    querySelector(selector) { return nodes.get(selector) || (selector in filterValues ? {value: filterValues[selector]} : null); },
    querySelectorAll(selector) { return selector === '[data-page]' ? nav : []; },
    addEventListener(type, fn) { listeners[`document:${type}`] = fn; },
    createElement() { return {className: '', textContent: ''}; }
  };
  class MockFormData {
    constructor() { this.entries = () => Object.entries(values); }
  }
  const context = {document, Inventory, FormData: MockFormData, setTimeout() {}, URL, Blob, Intl, Date, Number, String, Object, localStorage: storage};
  vm.runInNewContext(appSource, context, {filename: 'app.js'});
  return {
    content,
    toasts,
    dialog: nodes.get('#action-dialog'),
    body: nodes.get('#dialog-body'),
    title: nodes.get('#dialog-title'),
    topWarehouse: nodes.get('#top-warehouse'),
    submitButton: nodes.get('#dialog-submit'),
    setValues(next) { Object.assign(values, next); },
    chooseWarehouse(id) { filterValues['#warehouse-filter'] = id; for (const fn of listeners['content:input'] || []) fn({target: {id: 'warehouse-filter'}}); },
    stockRows() { return stockTable.innerHTML; },
    clickPage(page) {
      listeners['document:click']({preventDefault() {}, target: {closest(selector) {
        return selector === '[data-page]' ? {dataset: {page}} : null;
      }}});
    },
    clickAction(action, id, index) {
      listeners['document:click']({preventDefault() {}, target: {closest(selector) {
        return selector === '[data-action]' ? {dataset: {action, id, index: index === undefined ? undefined : String(index)}} : null;
      }}});
    },
    submit() { listeners.submit({preventDefault() {}, currentTarget: {}}); }
  };
}

test('demo provides its local assets and core navigation', () => {
  assert.match(html, /href="styles\.css"/);
  assert.match(html, /src="inventory\.js"/);
  assert.match(html, /src="app\.js"/);
  for (const page of ['dashboard', 'inventory', 'inbound', 'outbound', 'stocktake', 'reports']) {
    assert.match(html, new RegExp(`data-page="${page}"`));
  }
  const demo = makeDemo();
  assert.match(demo.content.innerHTML, /庫存趨勢/);
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /庫存明細/);
  assert.match(demo.content.innerHTML, /去骨雞腿排/);
  demo.chooseWarehouse('WH-SECOND');
  assert.equal(demo.topWarehouse.textContent, '竹南第二冷凍倉庫');
  demo.chooseWarehouse('全部倉庫');
  demo.clickAction('detail', 'LOT-260912-04');
  assert.equal(demo.title.textContent, '去骨雞腿排');
  demo.clickAction('inbound');
  assert.equal(demo.submitButton.hidden, false, 'action button should return after opening a read-only detail dialog');
  assert.match(demo.body.innerHTML, /name="temp" type="number" value="-20\.5"\s+required/, 'negative receiving temperature must be accepted');
  assert.equal((appSource.match(/else if\(mode==='start-count'\)/g) || []).length, 1);
  assert.equal((appSource.match(/else if\(mode==='record-count'\)/g) || []).length, 1);
  assert.equal((appSource.match(/else if\(mode==='confirm-count'\)/g) || []).length, 1);
  assert.equal((appSource.match(/else if\(dialogMode==='move'\)/g) || []).length, 1);
});

test('outbound guards stock, and inbound, scrap, and count update simulated inventory', () => {
  const demo = makeDemo();

  demo.clickAction('outbound');
  assert.match(demo.body.innerHTML, /出庫商品/);
  assert.ok(demo.body.innerHTML.indexOf('冷凍藍莓') < demo.body.innerHTML.indexOf('挪威鮭魚切片'), 'outbound options should follow FEFO order');
  assert.doesNotMatch(demo.body.innerHTML, /name="pickConfirmation"|name="confirmed"/, 'outbound should not require manual batch/location entry or an extra checkbox');
  demo.setValues({product: '澳洲穀飼牛五花', warehouseId: 'WH-NAN', qty: '30', partner: '測試客戶', operator: '林志明'});
  demo.submit();
  assert.ok(demo.toasts.at(-1).includes('揀貨任務已建立'));
  assert.equal(demo.dialog.open, false);
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /可用庫存 1,653 箱/, 'creating a pick task must not deduct inventory');

  demo.clickAction('outbound');
  demo.setValues({product: '澳洲穀飼牛五花', warehouseId: 'WH-NAN', qty: '999', partner: '測試客戶', operator: '林志明'});
  demo.submit();
  assert.ok(demo.toasts.at(-1).includes('可用庫存不足'));
  assert.equal(demo.dialog.open, true);

  demo.dialog.close();
  demo.clickPage('outbound');
  const taskId = demo.content.innerHTML.match(/data-task-id="([^"]+)"/)?.[1];
  assert.ok(taskId, 'submitted outbound should produce visible pick cards');
  demo.clickAction('confirm-pick', taskId, 0);
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /可用庫存 1,623 箱/);

  demo.clickAction('inbound');
  demo.setValues({name: '測試新品', category: '肉品', qty: '10', batch: 'T260929-A', expiry: '2027-01-01', location: 'B-02-01', partner: '測試供應商', temp: '-20.5', reason: ''});
  demo.submit();
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /測試新品/);
  assert.match(demo.content.innerHTML, /可用庫存 1,633 箱/);
  demo.clickPage('inbound');
  assert.match(demo.content.innerHTML, /今日入庫單[\s\S]*?<div class="metric-value">1<small>筆<\/small>/);
  assert.match(demo.content.innerHTML, /今日入庫數量[\s\S]*?<div class="metric-value">10<small>箱<\/small>/);

  demo.clickAction('scrap');
  demo.setValues({lot: 'LOT-260901-07', qty: '6', reason: '腐爛／變質', operator: '林志明'});
  demo.submit();
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /可用庫存 1,627 箱/);

  demo.clickAction('stocktake');
  demo.setValues({lot: 'LOT-260901-07', qty: '80', reason: '例行盤點差異', operator: '林志明'});
  demo.submit();
  demo.clickPage('stocktake');
  assert.match(demo.content.innerHTML, /待主管確認/);
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /可用庫存 1,627 箱/, 'submitted count must not change inventory before approval');
  demo.clickPage('stocktake');
  const pendingCountId = demo.content.innerHTML.match(/data-action="confirm-count" data-id="([^"]+)"/)?.[1];
  assert.ok(pendingCountId, 'submitted count should wait for supervisor confirmation');
  demo.clickAction('confirm-count', pendingCountId);
  demo.submit();
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /可用庫存 1,621 箱/);
  assert.ok(demo.toasts.at(-1).includes('盤點已確認'));
});

test('inventory changes persist across reloads and are traceable to their source', () => {
  const values = new Map();
  const storage = {getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); }};
  const demo = makeDemo(storage);
  demo.clickAction('inbound');
  demo.setValues({name: '可追溯測試品', category: '肉品', qty: '4', batch: 'TRACE-01', expiry: '2027-01-01', location: 'A-09-01', partner: '供應商甲', temp: '-20', reason: '收貨驗收'});
  demo.submit();
  assert.ok(values.has('shuangxu-wms-v1'), 'successful operations should be saved locally');

  const reloaded = makeDemo(storage);
  reloaded.clickPage('inventory');
  assert.match(reloaded.content.innerHTML, /可追溯測試品/);
  const state = JSON.parse(values.get('shuangxu-wms-v1'));
  const newLot = state.stock.find(item => item.name === '可追溯測試品');
  reloaded.clickAction('detail', newLot.id);
  assert.match(reloaded.body.innerHTML, /收貨驗收/);
  assert.match(reloaded.body.innerHTML, /IN-/);
});

test('two-warehouse acceptance scenario supports receipt, loss count, earliest receipt picking and relocation', () => {
  const demo = makeDemo();
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /竹南冷凍倉庫/);
  assert.match(demo.content.innerHTML, /竹南第二冷凍倉庫/);
  assert.match(demo.content.innerHTML, /高麗菜/);
  assert.match(demo.content.innerHTML, /id="warehouse-filter"/);
  demo.chooseWarehouse('WH-SECOND');
  assert.match(demo.stockRows(), /CABBAGE-260915/);
  assert.doesNotMatch(demo.stockRows(), /CABBAGE-260901/);
  demo.chooseWarehouse('全部倉庫');

  demo.clickAction('inbound');
  assert.match(demo.body.innerHTML, /name="inboundAt" type="datetime-local"/);
  assert.match(demo.body.innerHTML, /name="warehouseId"/);
  demo.setValues({name: '高麗菜', category: '蔬菜', qty: '2', batch: 'CABBAGE-TEST', expiry: '2027-01-01', location: 'B-08-01', warehouseId: 'WH-SECOND', inboundAt: '2026-09-29T08:00', partner: '竹南供應商', temp: '-20', reason: '收貨'});
  demo.submit();

  demo.clickAction('stocktake');
  demo.setValues({lot: 'LOT-CABBAGE-OLD', qty: '7', reason: '腐爛／不可售', operator: '林志明'});
  demo.submit();
  demo.clickPage('stocktake');
  const pendingCountId = demo.content.innerHTML.match(/data-action="confirm-count" data-id="([^"]+)"/)?.[1];
  assert.ok(pendingCountId);
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /可用庫存 1,655 箱/, 'count should remain pending without changing inventory');
  demo.clickPage('stocktake');
  demo.clickAction('confirm-count', pendingCountId);
  demo.submit();
  demo.clickAction('outbound');
  assert.match(demo.body.innerHTML, /最早批次 CABBAGE-260901/, 'earlier received cabbage batch should be selected first');
  demo.setValues({product: '高麗菜', warehouseId: 'WH-NAN', qty: '1', partner: '客戶甲', operator: '林志明'});
  demo.submit();
  demo.clickPage('outbound');
  const pickId = demo.content.innerHTML.match(/data-task-id="([^"]+)"/)?.[1];
  assert.ok(pickId);
  demo.clickAction('confirm-pick', pickId, 0);

  demo.clickAction('move');
  demo.setValues({lot: 'LOT-CABBAGE-OLD', location: 'A-05-03', reason: '出貨後整理', operator: '林志明'});
  demo.submit();
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /A-05-03/);
  assert.match(demo.content.innerHTML, /可用庫存 1,653 箱/);
  demo.clickAction('detail', 'LOT-CABBAGE-OLD');
  assert.match(demo.body.innerHTML, /移庫/);
  assert.match(demo.body.innerHTML, /出庫/);
  assert.match(demo.body.innerHTML, /盤點調整/);
});

test('daily warehouse count locks stock until physical counts are submitted and approved', () => {
  const demo = makeDemo();
  demo.clickAction('start-count');
  assert.match(demo.body.innerHTML, /盤點倉庫/);
  demo.setValues({warehouseId: 'WH-NAN', operator: '林志明'});
  demo.submit();
  assert.ok(demo.toasts.at(-1).includes('盤點任務已建立'));

  demo.clickAction('outbound');
  assert.doesNotMatch(demo.body.innerHTML, /CABBAGE-260901/, 'locked warehouse batches must not be offered for picking');
  demo.clickPage('stocktake');
  assert.match(demo.content.innerHTML, /待實盤/);
  const countId = demo.content.innerHTML.match(/data-action="record-count" data-id="([^"]+)"/)?.[1];
  assert.ok(countId, 'daily count should create an actionable task for each stock batch');

  demo.clickAction('record-count', countId);
  demo.setValues({qty: '0', reason: '腐爛／不可售', operator: '林志明'});
  demo.submit();
  assert.ok(demo.toasts.at(-1).includes('覆核前庫存維持原數量'));
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /可用庫存 1,653 箱/, 'count submission alone must not change book stock');

  demo.clickPage('stocktake');
  const reviewId = demo.content.innerHTML.match(/data-action="confirm-count" data-id="([^"]+)"/)?.[1];
  assert.ok(reviewId, 'submitted count should be routed to supervisor review');
  demo.clickAction('confirm-count', reviewId);
  demo.submit();
  assert.ok(demo.toasts.at(-1).includes('盤點已確認'));
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /可用庫存 1,167 箱/, 'approved actual count should reconcile the inventory quantity');
});

test('warehouse overview warns for pick tasks older than the timeout', () => {
  const values = new Map([['shuangxu-wms-v1', JSON.stringify({pickTasks:[{
    id:'OUT-OLD', product:'高麗菜', quantity:1, partner:'客戶甲', operator:'林志明', createdAt:0,
    status:'揀貨中', allocations:[{lotId:'LOT-CABBAGE-OLD', batch:'CABBAGE-260901', location:'A-01-01', inboundAt:'2026-09-01', qty:1, confirmed:false}]
  }]})]]);
  const demo = makeDemo({getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); }});
  assert.match(demo.content.innerHTML, /揀貨逾時警示/);
  assert.match(demo.content.innerHTML, /data-page="outbound"/);
});
