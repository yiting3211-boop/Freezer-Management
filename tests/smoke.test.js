const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Inventory = require('../inventory.js');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
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

function makeDemo(storage, {now} = {}) {
  const listeners = {};
  const toasts = [];
  const nav = ['dashboard', 'inventory', 'inbound', 'outbound', 'stocktake', 'stocktake-report', 'field', 'locations', 'reports', 'settings']
    .map(page => ({dataset: {page}, classList: {toggle() {}}}));
  const content = {innerHTML: '', addEventListener(type, fn) { (listeners[`content:${type}`] ||= []).push(fn); }};
  const values = {};
  const filterValues = {};
  const stockTable = {innerHTML: ''};
  let exportedBlob;
  const node = () => ({textContent: '', innerHTML: '', hidden: false, addEventListener(type, fn) { listeners[type] = fn; }});
  const nodes = new Map([
    ['#page-content', content], ['#today-date', node()], ['#breadcrumb-current', node()], ['#top-warehouse', node()], ['#nav-batch-count', node()],
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
    createElement() { return {className: '', textContent: '', click() {}}; }
  };
  class MockFormData {
    constructor() { this.entries = () => Object.entries(values); }
  }
  const DemoDate = now === undefined ? Date : class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return new Date(now).getTime(); }
  };
  const context = {document, Inventory, FormData: MockFormData, setTimeout() {}, URL:{createObjectURL(blob){exportedBlob=blob;return 'blob:test'},revokeObjectURL(){}}, Blob, Intl, Date:DemoDate, Number, String, Object, localStorage: storage};
  vm.runInNewContext(appSource, context, {filename: 'app.js'});
  return {
    content,
    toasts,
    dialog: nodes.get('#action-dialog'),
    body: nodes.get('#dialog-body'),
    title: nodes.get('#dialog-title'),
    topWarehouse: nodes.get('#top-warehouse'),
    navBatchCount: nodes.get('#nav-batch-count'),
    submitButton: nodes.get('#dialog-submit'),
    setValues(next) { Object.assign(values, next); },
    chooseWarehouse(id) { filterValues['#warehouse-filter'] = id; for (const fn of listeners['content:input'] || []) fn({target: {id: 'warehouse-filter'}}); },
    filterStatus(status) { filterValues['#status-filter'] = status; for (const fn of listeners['content:input'] || []) fn({target: {id: 'status-filter'}}); },
    filterCountWarehouse(id) { for (const fn of listeners['content:change'] || []) fn({target: {id: 'count-report-warehouse', value: id}}); },
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
    submit() { listeners.submit({preventDefault() {}, currentTarget: {}}); },
    exportedCsv() { return exportedBlob?.text(); },
    todayRecords() { return context.todayWorkRecords(); }
  };
}

test('today work records use Taiwan local date across the UTC date boundary', () => {
  const storage = {getItem() { return JSON.stringify({workRecords:[
    {id:'IN-TODAY', recordedAt:'2026-09-29T16:59:00.000Z'},
    {id:'IN-YESTERDAY', recordedAt:'2026-09-29T15:59:00.000Z'}
  ]}); }};
  const demo = makeDemo(storage, {now:'2026-09-29T17:00:00.000Z'});
  assert.deepEqual(Array.from(demo.todayRecords(), row=>row.id), ['IN-TODAY']);
});

test('demo provides its local assets and core navigation', () => {
  assert.match(html, /href="styles\.css"/);
  assert.match(styles, /\.sidebar\{[^}]*overflow-y:auto/);
  assert.match(styles, /\.sidebar>\*\{flex-shrink:0\}/);
  assert.match(html, /src="inventory\.js"/);
  assert.match(html, /src="app\.js"/);
  for (const page of ['dashboard', 'inventory', 'inbound', 'outbound', 'stocktake', 'stocktake-report', 'field', 'locations', 'reports']) {
    assert.match(html, new RegExp(`data-page="${page}"`));
  }
  const demo = makeDemo();
  assert.match(demo.content.innerHTML, /庫存趨勢/);
  assert.match(demo.content.innerHTML, /庫存批次/);
  assert.match(demo.content.innerHTML, /11<small>批次<\/small>/);
  assert.match(demo.content.innerHTML, /10 個使用中儲位/);
  assert.doesNotMatch(demo.content.innerHTML, /較上週同期|4\.8%|128<small>項/);
  assert.equal(demo.navBatchCount.textContent, '11');
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /庫存明細/);
  assert.match(demo.content.innerHTML, /冷凍甜玉米粒/);
  assert.match(demo.content.innerHTML, /最早入庫批次 · A-01-01/);
  assert.match(demo.content.innerHTML, /久放/);
  demo.chooseWarehouse('WH-SECOND');
  assert.equal(demo.topWarehouse.textContent, '竹南第二冷凍倉庫');
  demo.chooseWarehouse('全部倉庫');
  demo.clickPage('field');
  assert.match(demo.content.innerHTML, /現場作業已完成/);
  demo.clickPage('locations');
  assert.equal(demo.topWarehouse.textContent, '竹南冷凍倉庫');
  assert.match(demo.content.innerHTML, /A-01-01/);
  assert.match(demo.content.innerHTML, /slot-used/);
  demo.clickAction('location-detail', 'A-01-01');
  assert.equal(demo.title.textContent, 'A-01-01');
  assert.match(demo.body.innerHTML, /CABBAGE-260901/);
  demo.clickPage('inventory');
  demo.clickAction('detail', 'LOT-260912-04');
  assert.equal(demo.title.textContent, '冷凍甜玉米粒');
  demo.clickAction('inbound');
  assert.equal(demo.submitButton.hidden, false, 'action button should return after opening a read-only detail dialog');
  assert.match(demo.body.innerHTML, /name="temp" type="number" value="-20\.5"\s+required/, 'negative receiving temperature must be accepted');
  assert.match(demo.body.innerHTML, /id="inbound-fifo-hint"/);
  assert.match(demo.body.innerHTML, /inbound-location-recommendation/);
  assert.equal((appSource.match(/else if\(mode==='start-count'\)/g) || []).length, 1);
  assert.equal((appSource.match(/else if\(mode==='record-count'\)/g) || []).length, 1);
  assert.equal((appSource.match(/else if\(mode==='confirm-count'\)/g) || []).length, 1);
  assert.equal((appSource.match(/else if\(dialogMode==='move'\)/g) || []).length, 1);
});

test('basic data counts come from inventory and records, not fixed demo totals', () => {
  const demo = makeDemo();
  demo.clickPage('settings');
  assert.match(demo.content.innerHTML, /商品主檔 · 10 項/);
  assert.match(demo.content.innerHTML, /倉庫位置 · 10 個使用中儲位/);
  assert.match(demo.content.innerHTML, /合作夥伴 · 4 家/);
  assert.doesNotMatch(demo.content.innerHTML, /128 項|36 家|12 個儲位|使用者與角色 · 8 位/);
});

test('inventory screens show produce instead of meat products or categories', () => {
  const demo = makeDemo();
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /冷凍甜玉米粒|冷凍南瓜塊|紅蘿蔔丁/);
  assert.doesNotMatch(demo.content.innerHTML, /去骨雞腿排|澳洲穀飼牛五花|紐西蘭羊肩排|肉品|禽肉/);
});

test('existing browser sample data is updated to the produce catalog', () => {
  const legacy = {getItem() { return JSON.stringify({
    stock:[{id:'LOT-260912-04',name:'舊示範品項',category:'舊示範分類',warehouseId:'WH-NAN',inboundAt:'2026-09-01T09:00',qty:10,location:'A-02-04'}],
    workRecords:[{id:'IN-20260929-008',item:'舊示範品項',status:'已完成'}],
    activities:[{type:'in',detail:'IN-20260929-008 · 舊示範品項',icon:'↙',text:'完成入庫',time:'09:42',qty:'+ 1 箱'}]
  }); }};
  const demo = makeDemo(legacy);
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /冷凍甜玉米粒/);
  assert.doesNotMatch(demo.content.innerHTML, /舊示範品項|舊示範分類/);
});

test('reports derive turnover, expiry, loss and category totals from current demo data', () => {
  const demo = makeDemo();
  demo.clickPage('reports');
  assert.match(demo.content.innerHTML, /1,117 箱/);
  assert.match(demo.content.innerHTML, /444 箱/);
  assert.match(demo.content.innerHTML, /效期風險庫存[\s\S]*個有庫存批次將於 30 天內到期/);
  assert.doesNotMatch(demo.content.innerHTML, /18\.6|報廢 6 箱 · 盤點差異 2 箱/);

  demo.clickAction('inbound');
  demo.setValues({name:'報表測試商品', category:'測試分類', qty:'7', batch:'REPORT-01', expiry:'2027-01-01', location:'A-09-01', partner:'測試供應商', temp:'-20', reason:'測試入庫'});
  demo.submit();
  demo.clickPage('reports');
  assert.match(demo.content.innerHTML, /測試分類/);
  assert.match(demo.content.innerHTML, /7 箱/);
});

test('expiry labels, filters, overview and CSV use calculated dates rather than stored status', async () => {
  const futureExpiry=Inventory.localDateString(new Date(Date.now()+20*86400000));
  const saved={stock:[
    {id:'STALE-EXPIRY',sku:'T-1',name:'舊效期旗標',category:'其他',batch:'OLD-STATUS',location:'A-08-01',qty:2,unit:'箱',expiry:'2099-12-31',status:'即將到期',temp:'-20°C',warehouseId:'WH-NAN',inboundAt:'2026-09-01T08:00'},
    {id:'SCRAP-STATUS',sku:'T-2',name:'已報廢品',category:'其他',batch:'SCRAP-01',location:'A-08-02',qty:0,unit:'箱',expiry:'2099-12-31',status:'待報廢',temp:'-20°C',warehouseId:'WH-NAN',inboundAt:'2026-09-01T08:00'}
  ]};
  const storage={getItem(){return JSON.stringify(saved)},setItem(){}};
  const demo=makeDemo(storage);
  demo.clickAction('inbound');
  demo.setValues({name:'動態效期商品',category:'蔬菜',qty:'5',batch:'EXPIRY-20D',expiry:futureExpiry,location:'A-08-03',partner:'測試供應商',temp:'-20',reason:'測試效期'});
  demo.submit();
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML,/動態效期商品[\s\S]*即將到期/,'new inbound within thirty days should be dynamically marked');
  demo.filterStatus('即將到期');
  assert.match(demo.stockRows(),/動態效期商品/);
  assert.doesNotMatch(demo.stockRows(),/舊效期旗標/,'stale stored expiry status should not drive the filter');
  demo.clickPage('dashboard');
  assert.match(demo.content.innerHTML,/動態效期商品/,'overview expiry list should use the same calculated status');
  demo.clickPage('inventory');
  demo.clickAction('export');
  const initialCsv=await demo.exportedCsv();
  assert.match(initialCsv,/EXPIRY-20D[^\r\n]*即將到期/);
  assert.match(initialCsv,/OLD-STATUS[^\r\n]*正常/);
  assert.match(initialCsv,/SCRAP-01[^\r\n]*待報廢/);

  demo.clickAction('start-count');
  demo.setValues({warehouseId:'WH-NAN',operator:'林志明'});
  demo.submit();
  demo.clickPage('inventory');
  demo.filterStatus('盤點中');
  assert.match(demo.stockRows(),/動態效期商品[\s\S]*盤點中/,'count lock should take precedence as a dynamic status');
  demo.clickAction('export');
  assert.match(await demo.exportedCsv(),/EXPIRY-20D[^\r\n]*盤點中/);
});

test('pick tasks can be cancelled from field mode after entering a reason and confirming', () => {
  const demo=makeDemo();
  demo.clickAction('outbound');
  demo.setValues({product:'冷凍南瓜塊',warehouseId:'WH-NAN',qty:'20',partner:'測試客戶',operator:'林志明'});
  demo.submit();
  demo.clickPage('outbound');
  const taskId=demo.content.innerHTML.match(/data-task-id="([^"]+)"/)?.[1];
  assert.ok(taskId);
  assert.match(demo.content.innerHTML,/取消任務/,'outbound task cards should offer cancellation');
  demo.clickPage('field');
  assert.match(demo.content.innerHTML,/data-action="cancel-pick-task"/,'field task should offer cancellation');
  demo.clickAction('cancel-pick-task',taskId);
  assert.match(demo.body.innerHTML,/取消原因/);
  demo.setValues({reason:'客戶取消訂單',operator:'林志明'});
  demo.submit();
  assert.equal(demo.title.textContent,'確定取消此揀貨任務？','first submit should present a second confirmation step');
  assert.match(demo.body.innerHTML,/客戶取消訂單/);
  demo.submit();
  assert.ok(demo.toasts.at(-1).includes('庫存數量未變'));
  demo.clickPage('outbound');
  assert.doesNotMatch(demo.content.innerHTML,new RegExp(`data-task-id="${taskId}"`));
  assert.match(demo.content.innerHTML,/已取消/,'outbound work record should reflect the cancellation status');
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML,/可用庫存 1,653 箱/,'cancelling the task must not debit inventory');
  demo.clickAction('start-count');
  demo.setValues({warehouseId:'WH-NAN',operator:'林志明'});
  demo.submit();
  assert.ok(demo.toasts.at(-1).includes('盤點任務已建立'),'cancellation must allow count to start');
});

test('outbound guards stock, and inbound, scrap, and count update simulated inventory', () => {
  const demo = makeDemo();

  demo.clickAction('outbound');
  assert.match(demo.body.innerHTML, /出庫商品/);
  assert.ok(demo.body.innerHTML.indexOf('冷凍藍莓') < demo.body.innerHTML.indexOf('挪威鮭魚切片'), 'outbound options should follow FEFO order');
  assert.doesNotMatch(demo.body.innerHTML, /name="pickConfirmation"|name="confirmed"/, 'outbound should not require manual batch/location entry or an extra checkbox');
  demo.setValues({product: '冷凍南瓜塊', warehouseId: 'WH-NAN', qty: '30', partner: '測試客戶', operator: '林志明'});
  demo.submit();
  assert.ok(demo.toasts.at(-1).includes('揀貨任務已建立'));
  assert.equal(demo.dialog.open, false);
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /可用庫存 1,653 箱/, 'creating a pick task must not deduct inventory');

  demo.clickAction('outbound');
  demo.setValues({product: '冷凍南瓜塊', warehouseId: 'WH-NAN', qty: '999', partner: '測試客戶', operator: '林志明'});
  demo.submit();
  assert.ok(demo.toasts.at(-1).includes('可用庫存不足'));
  assert.equal(demo.dialog.open, true);

  demo.dialog.close();
  demo.clickPage('outbound');
  const taskId = demo.content.innerHTML.match(/data-task-id="([^"]+)"/)?.[1];
  assert.ok(taskId, 'submitted outbound should produce visible pick cards');
  demo.clickPage('field');
  assert.match(demo.content.innerHTML, /本次取貨/);
  assert.doesNotMatch(demo.content.innerHTML, /data-task-id="[^"]+"[\s\S]*data-task-id="[^"]+"/, 'field mode should show one current task only');
  demo.clickAction('confirm-pick', taskId, 0);
  demo.clickPage('inventory');
  assert.match(demo.content.innerHTML, /可用庫存 1,623 箱/);

  demo.clickAction('inbound');
  demo.setValues({name: '測試新品', category: '蔬菜', qty: '10', batch: 'T260929-A', expiry: '2027-01-01', location: 'B-02-01', partner: '測試供應商', temp: '-20.5', reason: ''});
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
  assert.match(demo.content.innerHTML, /可用庫存 1,633 箱/, 'pending scrap must not change available stock');
  demo.clickPage('stocktake');
  const pendingScrapId = demo.content.innerHTML.match(/data-action="confirm-scrap" data-id="([^"]+)"/)?.[1];
  assert.ok(pendingScrapId, 'pending scrap should wait for supervisor approval');
  demo.clickAction('confirm-scrap', pendingScrapId);
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
  demo.clickPage('stocktake-report');
  assert.match(demo.content.innerHTML, /盤點差異報表/);
  assert.match(demo.content.innerHTML, /盤點與報廢歷史/);
  assert.match(demo.content.innerHTML, /例行盤點差異/);
  demo.filterCountWarehouse('WH-NAN');
  assert.match(demo.content.innerHTML, /例行盤點差異/, 'warehouse filter should retain this warehouse\'s confirmed variance');
  demo.clickAction('record-detail', pendingCountId);
  assert.match(demo.body.innerHTML, new RegExp(pendingCountId));
  assert.match(demo.body.innerHTML, /例行盤點差異/);
  assert.match(demo.body.innerHTML, /實盤數量／報廢量[\s\S]*80 箱/);
  assert.doesNotMatch(demo.body.innerHTML, /84 箱|外箱破損/);
});

test('inventory changes persist across reloads and are traceable to their source', () => {
  const values = new Map();
  const storage = {getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); }};
  const demo = makeDemo(storage);
  demo.clickAction('inbound');
  demo.setValues({name: '可追溯測試品', category: '蔬菜', qty: '4', batch: 'TRACE-01', expiry: '2027-01-01', location: 'A-09-01', partner: '供應商甲', temp: '-20', reason: '收貨驗收'});
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
  assert.match(demo.body.innerHTML, /2026-09-01/, 'outbound selection should show the oldest lot receipt time');
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
