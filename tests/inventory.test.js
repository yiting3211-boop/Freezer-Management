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
