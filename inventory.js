/* DOM-free inventory rules shared by the browser app and Node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Inventory = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const PICK_TASK_TIMEOUT_MS = 30 * 60 * 1000;
  function isCountLocked(countRows, lotId) {
    return countRows.some(row => row.lotId === lotId && ['待盤點', '待確認'].includes(row.status));
  }

  function planPick(stock, countRows, product, warehouseId, quantity) {
    const qty = Number(quantity);
    if (!product || !Number.isFinite(qty) || qty <= 0) return null;
    const lots = stock.filter(item => item.name === product && item.warehouseId === warehouseId &&
      item.qty > 0 && item.status !== '待報廢' && !isCountLocked(countRows, item.id))
      .sort((a, b) => String(a.inboundAt || '').localeCompare(String(b.inboundAt || '')) ||
        String(a.expiry || '').localeCompare(String(b.expiry || '')));
    if (lots.reduce((sum, item) => sum + item.qty, 0) < qty) return {insufficient: true, lots};
    let remaining = qty;
    return lots.flatMap(item => {
      if (remaining <= 0) return [];
      const take = Math.min(item.qty, remaining);
      remaining -= take;
      return [{item, qty: take}];
    });
  }

  function recordChange(state, {lot, type, quantity, reason, operator = '林志明', documentId, time}) {
    const entry = {id: `${type}-${Date.now()}-${state.audit.length}`, lot, type, quantity,
      reason, operator, documentId, time: time || new Date().toLocaleString('zh-TW')};
    state.audit.unshift(entry);
    return entry;
  }

  function receive(state, {name, category = '其他', qty, batch, expiry, location, warehouseId, inboundAt,
    temp = '-20.5°C', unit = '箱', sku, id, partner, operator = '林志明', reason = '收貨上架', documentId}) {
    const amount = Number(qty);
    if (!name || !batch || !location || !warehouseId || !Number.isFinite(amount) || amount <= 0)
      return {ok: false, error: '入庫資料不完整或數量無效'};
    let item = state.stock.find(row => row.name.toLowerCase() === name.trim().toLowerCase() &&
      row.batch.toLowerCase() === batch.trim().toLowerCase() && row.warehouseId === warehouseId);
    const created = !item;
    if (item) item.qty += amount;
    else {
      item = {id: id || `LOT-${Date.now()}`, sku: sku || '', name: name.trim(), category, batch: batch.trim(),
        location: location.trim(), qty: amount, unit, expiry: expiry || '', status: '正常', temp,
        warehouseId, inboundAt: inboundAt || new Date().toISOString().slice(0, 16)};
      state.stock.unshift(item);
    }
    item.location = location.trim();
    item.inboundAt = inboundAt || item.inboundAt || new Date().toISOString().slice(0, 16);
    item.status = item.status === '待報廢' ? '正常' : item.status;
    item.temp = temp;
    const doc = documentId || `IN-${Date.now()}`;
    recordChange(state, {lot: item.id, type: '入庫', quantity: `+${amount} 箱`, reason, operator, documentId: doc});
    return {ok: true, item, created, amount, documentId: doc, partner, operator};
  }

  function dispatch(state, {product, warehouseId, quantity, operator = '林志明', partner = '未指定',
    reason = '出庫', documentId, plan}) {
    const qty = Number(quantity);
    const allocation = plan || planPick(state.stock, state.countRows, product, warehouseId, qty);
    if (!allocation || allocation.insufficient || !Number.isFinite(qty) || qty <= 0)
      return {ok: false, error: '商品可用庫存不足或出庫資料不完整'};
    for (const row of allocation) {
      const current = state.stock.find(item => item.id === row.item.id);
      if (!current || isCountLocked(state.countRows, current.id) || current.qty < row.qty)
        return {ok: false, error: '批次庫存已變動或盤點中，請重新揀貨'};
    }
    const doc = documentId || `OUT-${Date.now()}`;
    allocation.forEach(({item, qty: take}) => {
      item.qty -= take;
      recordChange(state, {lot: item.id, type: '出庫', quantity: `-${take} 箱`, reason, operator, documentId: doc});
    });
    return {ok: true, plan: allocation, documentId: doc, quantity: qty};
  }

  function createPickTask(state, {product, warehouseId, quantity, operator = '林志明', partner = '未指定', reason = '', now = Date.now()}) {
    const qty = Number(quantity);
    const reserved = new Map();
    state.pickTasks.filter(task => ['揀貨中', '已揀貨待確認'].includes(task.status)).forEach(task => task.allocations.forEach(row => {
      reserved.set(row.lotId, (reserved.get(row.lotId) || 0) + row.qty);
    }));
    const availableStock = state.stock.map(item => ({...item, qty: item.qty - (reserved.get(item.id) || 0)}));
    const plan = planPick(availableStock, state.countRows, product, warehouseId, qty);
    if (!plan || plan.insufficient) return {ok: false, error: '商品可用庫存不足或出庫資料不完整'};
    const id = `OUT-${now}-${state.pickTasks.length}`;
    const task = {id, product, warehouseId, quantity: qty, operator, partner, reason, createdAt: now,
      status: '揀貨中', allocations: plan.map(({item, qty: take}) => ({lotId: item.id, batch: item.batch,
        location: item.location, inboundAt: item.inboundAt, qty: take,
        bookQty: state.stock.find(row => row.id === item.id).qty, confirmed: false}))};
    state.pickTasks.unshift(task);
    state.workRecords.unshift({id, type: '出庫', item: product,
      batch: task.allocations.map(row => `${row.batch} ${row.qty}箱 @ ${row.location}`).join('、'),
      qty: `−${qty} 箱`, partner, operator, time: new Date(now).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'}),
      recordedAt: new Date(now).toISOString(), status: '揀貨中'});
    return {ok: true, task};
  }

  function isPickTaskOverdue(task, now = Date.now()) {
    return ['揀貨中', '已揀貨待確認'].includes(task.status) && now - Number(task.createdAt) >= PICK_TASK_TIMEOUT_MS;
  }

  function confirmPick(state, {taskId, allocationIndex, now = Date.now()}) {
    const task = state.pickTasks.find(row => row.id === taskId);
    if (!task || !['揀貨中', '已揀貨待確認'].includes(task.status)) return {ok: false, error: '此揀貨任務已處理或不存在'};
    const allocation = task.allocations[Number(allocationIndex)];
    if (!allocation) return {ok: false, error: '找不到此批揀貨項目'};
    allocation.confirmed = true;
    const remaining = task.allocations.filter(row => !row.confirmed).length;
    if (remaining) {
      task.status = '已揀貨待確認';
      const record = state.workRecords.find(row => row.id === task.id);
      if (record) record.status = task.status;
      return {ok: true, complete: false, task, remaining};
    }
    const plan = task.allocations.map(row => ({item: state.stock.find(item => item.id === row.lotId), qty: row.qty}));
    if (plan.some(({item, qty}, index) => !item || isCountLocked(state.countRows, item.id) ||
      item.qty < qty || item.qty !== task.allocations[index].bookQty)) {
      allocation.confirmed = false;
      return {ok: false, error: '揀貨期間庫存或盤點狀態已變動，請取消並重新建立出庫單'};
    }
    const dispatched = dispatch(state, {product: task.product, warehouseId: task.warehouseId,
      quantity: task.quantity, operator: task.operator, partner: task.partner,
      reason: task.reason || '已完成全部批次揀貨確認', documentId: task.id, plan});
    if (!dispatched.ok) { allocation.confirmed = false; return dispatched; }
    task.status = '已完成';
    task.completedAt = now;
    const record = state.workRecords.find(row => row.id === task.id);
    if (record) { record.status = '已完成'; record.completedAt = new Date(now).toISOString(); }
    return {ok: true, complete: true, task, remaining: 0, plan};
  }

  function startCount(state, {warehouseId, operator = '林志明', date = new Date().toISOString().slice(0, 10), idPrefix = 'ST'}) {
    const lots = state.stock.filter(item => item.warehouseId === warehouseId);
    if (!warehouseId || !lots.length) return {ok: false, error: '所選倉庫沒有可盤點的批次'};
    if (state.countRows.some(row => row.sessionId && row.warehouseId === warehouseId && row.date === date &&
      ['待盤點', '待確認'].includes(row.status))) return {ok: false, error: '此倉庫今天已有尚未完成的盤點任務'};
    if (lots.some(item => isCountLocked(state.countRows, item.id))) return {ok: false, error: '倉庫中有其他未完成的盤點單'};
    const sessionId = `CTS-${Date.now()}`;
    const rows = lots.map((item, index) => ({id: `${idPrefix}-${Date.now()}-${index + 1}`, sessionId, lotId: item.id,
      warehouseId, scope: `${item.location} · ${item.name} · ${item.batch}`, date, operator, bookQty: item.qty,
      diff: '待實盤', status: '待盤點'}));
    state.countRows.unshift(...rows);
    return {ok: true, rows, sessionId};
  }

  function recordCount(state, {rowId, actualQty, reason, operator, idPrefix = 'ST'}) {
    const row = state.countRows.find(entry => entry.id === rowId);
    const item = row && state.stock.find(entry => entry.id === row.lotId);
    const qty = Number(actualQty);
    if (!row || row.status !== '待盤點' || !item || !Number.isFinite(qty) || qty < 0 || !reason)
      return {ok: false, error: '盤點任務或實盤資料無效'};
    if (item.qty !== row.bookQty) {
      row.status = '已作廢';
      return {ok: false, voided: true, error: '盤點期間帳面數量已變動，任務已作廢'};
    }
    const diff = qty - row.bookQty;
    Object.assign(row, {actualQty: qty, reason, operator: operator || row.operator,
      diff: `${diff > 0 ? '+' : ''}${diff} 箱`, status: '待確認'});
    return {ok: true, row, diff};
  }

  function submitCount(state, {lotId, actualQty, reason, operator = '林志明', date = new Date().toISOString().slice(0, 10)}) {
    const item = state.stock.find(entry => entry.id === lotId), qty = Number(actualQty);
    if (!item || isCountLocked(state.countRows, lotId) || !Number.isFinite(qty) || qty < 0 || !reason)
      return {ok: false, error: '盤點資料無效或此批次已有未完成盤點'};
    const diff = qty - item.qty;
    const row = {id: `ST-${Date.now()}`, lotId, scope: `${item.location} · ${item.name} · ${item.batch}`,
      date, operator, bookQty: item.qty, actualQty: qty, diff: `${diff > 0 ? '+' : ''}${diff} 箱`, reason, status: '待確認'};
    state.countRows.unshift(row);
    return {ok: true, row, diff};
  }

  function approveCount(state, {rowId, operator = '林志明'}) {
    const row = state.countRows.find(entry => entry.id === rowId);
    const item = row && state.stock.find(entry => entry.id === row.lotId);
    if (!row || row.status !== '待確認' || !item) return {ok: false, error: '找不到待確認盤點單'};
    if (item.qty !== row.bookQty) return {ok: false, stale: true, error: '盤點期間庫存已變動，請重新盤點'};
    const diff = row.actualQty - row.bookQty;
    item.qty = row.actualQty;
    row.status = '已確認';
    const audit = recordChange(state, {lot: item.id, type: '盤點調整',
      quantity: `${diff > 0 ? '+' : ''}${diff} 箱`, reason: row.reason, operator, documentId: row.id});
    return {ok: true, item, row, diff, audit};
  }

  function scrap(state, {lotId, quantity, reason, operator = '林志明', documentId}) {
    const item = state.stock.find(row => row.id === lotId), qty = Number(quantity);
    if (!item || !Number.isFinite(qty) || qty <= 0 || qty > item.qty || !reason || isCountLocked(state.countRows, lotId))
      return {ok: false, error: '報廢資料無效或批次盤點中'};
    item.qty -= qty;
    if (item.qty === 0) item.status = '待報廢';
    const doc = documentId || `SC-${Date.now()}`;
    recordChange(state, {lot: item.id, type: '報廢', quantity: `-${qty} 箱`, reason, operator, documentId: doc});
    return {ok: true, item, quantity: qty, documentId: doc};
  }

  function move(state, {lotId, location, reason, operator = '林志明', documentId}) {
    const item = state.stock.find(row => row.id === lotId);
    if (!item || !location || !reason || isCountLocked(state.countRows, lotId)) return {ok: false, error: '移庫資料無效或批次盤點中'};
    const previous = item.location;
    item.location = location;
    const doc = documentId || `MV-${Date.now()}`;
    recordChange(state, {lot: item.id, type: '移庫', quantity: `${item.qty} 箱`, reason: `${previous} → ${location}；${reason}`, operator, documentId: doc});
    return {ok: true, item, previous, documentId: doc};
  }

  return {PICK_TASK_TIMEOUT_MS, isCountLocked, planPick, recordChange, receive, dispatch, createPickTask, confirmPick,
    isPickTaskOverdue, startCount, recordCount, submitCount, approveCount, scrap, move};
});
