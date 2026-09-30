const test = require('node:test');
const assert = require('node:assert/strict');
const Inventory = require('../inventory.js');

function fixture() {
  return {stock: [
    {id:'new', name:'高麗菜', warehouseId:'W', qty:4, inboundAt:'2026-09-02', expiry:'2027-01-01', location:'B-2'},
    {id:'old-late', name:'高麗菜', warehouseId:'W', qty:2, inboundAt:'2026-09-01', expiry:'2026-12-01', location:'A-2'},
    {id:'old-early', name:'高麗菜', warehouseId:'W', qty:3, inboundAt:'2026-09-01', expiry:'2026-11-01', location:'A-1'}
  ], audit: [], countRows: []};
}

test('FIFO orders by receipt timestamp then expiry and allocates across batches', () => {
  const state = fixture();
  const plan = Inventory.planPick(state.stock, state.countRows, '高麗菜', 'W', 6);
  assert.deepEqual(plan.map(({item, qty}) => [item.id, qty]), [['old-early', 3], ['old-late', 2], ['new', 1]]);
});

test('pick planning reports insufficient stock and excludes count-locked lots', () => {
  const state = fixture();
  state.countRows.push({lotId:'old-early', status:'待盤點'});
  assert.equal(Inventory.isCountLocked(state.countRows, 'old-early'), true);
  assert.equal(Inventory.planPick(state.stock, state.countRows, '高麗菜', 'W', 7).insufficient, true);
});

test('stale count is voided; approved count adjusts stock and writes audit only after review', () => {
  const state = fixture();
  const started = Inventory.startCount(state, {warehouseId:'W', date:'2026-09-30'});
  assert.equal(started.ok, true);
  const row = started.rows.find(entry => entry.lotId === 'old-early');
  assert.equal(Inventory.planPick(state.stock, state.countRows, '高麗菜', 'W', 1).lots.length, 0);
  state.stock.find(item => item.id === 'old-early').qty++;
  const stale = Inventory.recordCount(state, {rowId:row.id, actualQty:3, reason:'例行盤點差異'});
  assert.equal(stale.voided, true);
  assert.equal(row.status, '已作廢');

  state.countRows = [];
  const fresh = Inventory.startCount(state, {warehouseId:'W', date:'2026-10-01'});
  const task = fresh.rows.find(entry => entry.lotId === 'old-early');
  assert.equal(Inventory.recordCount(state, {rowId:task.id, actualQty:2, reason:'短少'}).ok, true);
  assert.equal(state.stock.find(item => item.id === 'old-early').qty, 4, 'unapproved count must not change stock');
  const approved = Inventory.approveCount(state, {rowId:task.id});
  assert.equal(approved.ok, true);
  assert.equal(state.stock.find(item => item.id === 'old-early').qty, 2);
  assert.equal(state.audit.at(-1).type, '盤點調整');
  assert.equal(state.audit.at(-1).documentId, task.id);
});

test('inbound, outbound, scrap, and relocation update state with audit trail', () => {
  const state = fixture();
  const received = Inventory.receive(state, {name:'青江菜', batch:'L-1', qty:5, location:'C-1', warehouseId:'W', category:'蔬菜', reason:'收貨'});
  assert.equal(received.ok, true);
  const plan = Inventory.planPick(state.stock, state.countRows, '青江菜', 'W', 2);
  assert.equal(Inventory.dispatch(state, {product:'青江菜', warehouseId:'W', quantity:2, plan}).ok, true);
  assert.equal(Inventory.move(state, {lotId:received.item.id, location:'C-2', reason:'整理'}).ok, true);
  assert.equal(Inventory.scrap(state, {lotId:received.item.id, quantity:1, reason:'破損'}).ok, true);
  assert.equal(received.item.qty, 2);
  assert.deepEqual(state.audit.map(row => row.type), ['報廢', '移庫', '出庫', '入庫']);
});

test('pick task keeps book stock unchanged after partial confirmation and deducts only after all picks', () => {
  const state = fixture();
  state.pickTasks = [];
  state.workRecords = [];
  const created = Inventory.createPickTask(state, {product:'高麗菜', warehouseId:'W', quantity:6, now:1000});
  assert.equal(created.ok, true);
  assert.equal(created.task.allocations.length, 3);
  assert.equal(state.stock.reduce((sum, row) => sum + row.qty, 0), 9);
  const partial = Inventory.confirmPick(state, {taskId:created.task.id, allocationIndex:0, now:2000});
  assert.equal(partial.complete, false);
  assert.equal(partial.remaining, 2);
  assert.equal(created.task.status, '已揀貨待確認');
  assert.equal(state.stock.reduce((sum, row) => sum + row.qty, 0), 9);
  const second = Inventory.confirmPick(state, {taskId:created.task.id, allocationIndex:1, now:3000});
  assert.equal(second.complete, false);
  const complete = Inventory.confirmPick(state, {taskId:created.task.id, allocationIndex:2, now:4000});
  assert.equal(complete.complete, true);
  assert.equal(state.stock.reduce((sum, row) => sum + row.qty, 0), 3);
  assert.equal(created.task.status, '已完成');
  assert.equal(state.workRecords[0].status, '已完成');
  assert.equal(state.audit.filter(row => row.type === '出庫').length, 3);
});

test('pick task overdue threshold is thirty minutes and does not flag completed work', () => {
  const state = fixture(); state.pickTasks = []; state.workRecords = [];
  const {task} = Inventory.createPickTask(state, {product:'高麗菜', warehouseId:'W', quantity:1, now:1000});
  assert.equal(Inventory.PICK_TASK_TIMEOUT_MS, 30 * 60 * 1000);
  assert.equal(Inventory.isPickTaskOverdue(task, 1000 + Inventory.PICK_TASK_TIMEOUT_MS - 1), false);
  assert.equal(Inventory.isPickTaskOverdue(task, 1000 + Inventory.PICK_TASK_TIMEOUT_MS), true);
  task.status = '已完成';
  assert.equal(Inventory.isPickTaskOverdue(task, 1000 + Inventory.PICK_TASK_TIMEOUT_MS * 2), false);
});

test('open tasks reserve planned quantities so parallel pickers cannot oversubscribe a batch', () => {
  const state = fixture(); state.pickTasks = []; state.workRecords = [];
  assert.equal(Inventory.createPickTask(state, {product:'高麗菜', warehouseId:'W', quantity:9, now:1000}).ok, true);
  const second = Inventory.createPickTask(state, {product:'高麗菜', warehouseId:'W', quantity:1, now:2000});
  assert.equal(second.ok, false);
});
