<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  fetchByProject,
  fetchMonthly,
  fetchUnsettled,
  type ProjectTotal,
  type MonthlyTotal,
  type TransactionItem,
} from '../api'

const projects = ref<ProjectTotal[]>([])
const monthly = ref<MonthlyTotal[]>([])
const unsettled = ref<TransactionItem[]>([])
const loading = ref(false)
const error = ref('')

function money(n: number): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}
function day(t: number): string {
  return t ? new Date(t).toLocaleDateString('zh-CN') : ''
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [p, m, u] = await Promise.all([fetchByProject(), fetchMonthly(), fetchUnsettled()])
    projects.value = p.items
    monthly.value = m.items
    unsettled.value = u.items
  } catch (e: any) {
    error.value = e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="stats">
    <div class="toolbar">
      <button @click="load" :disabled="loading">{{ loading ? '加载中...' : '刷新统计' }}</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <section>
      <h3>按业务汇总 <span class="muted">({{ projects.length }})</span></h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>业务</th><th>收入 HKD</th><th>支出 HKD</th><th>结余 HKD</th>
              <th>收入 RMB</th><th>支出 RMB</th><th>结余 RMB</th><th>笔数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in projects" :key="p.project_id">
              <td class="name">{{ p.project_name }}</td>
              <td class="in">{{ money(p.income_hkd) }}</td>
              <td class="out">{{ money(p.expense_hkd) }}</td>
              <td :class="p.net_hkd >= 0 ? 'in' : 'out'">{{ money(p.net_hkd) }}</td>
              <td class="in">{{ money(p.income_rmb) }}</td>
              <td class="out">{{ money(p.expense_rmb) }}</td>
              <td :class="p.net_rmb >= 0 ? 'in' : 'out'">{{ money(p.net_rmb) }}</td>
              <td class="muted">{{ p.count }}</td>
            </tr>
            <tr v-if="!projects.length"><td colspan="8" class="empty">暂无数据</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h3>按月汇总</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>月份</th><th>收入 HKD</th><th>支出 HKD</th>
              <th>收入 RMB</th><th>支出 RMB</th><th>笔数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in monthly" :key="m.month">
              <td class="name">{{ m.month }}</td>
              <td class="in">{{ money(m.income_hkd) }}</td>
              <td class="out">{{ money(m.expense_hkd) }}</td>
              <td class="in">{{ money(m.income_rmb) }}</td>
              <td class="out">{{ money(m.expense_rmb) }}</td>
              <td class="muted">{{ m.count }}</td>
            </tr>
            <tr v-if="!monthly.length"><td colspan="6" class="empty">暂无数据</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h3>待结清 <span class="muted">({{ unsettled.length }})</span></h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期</th><th>类型</th><th>业务</th><th>款项</th><th>对象 / 账户</th><th>金额</th><th>明细</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in unsettled" :key="t.id">
              <td>{{ day(t.occurred_at) }}</td>
              <td><span class="tag" :class="t.direction">{{ t.direction === 'income' ? '收款' : '转出' }}</span></td>
              <td class="name">{{ t.project_name || t.project_name_raw }}</td>
              <td>{{ t.kind }}</td>
              <td>{{ t.direction === 'income' ? t.counterparty_name : t.counterparty_account }}</td>
              <td>{{ money(t.amount) }} {{ t.currency }}</td>
              <td class="muted small">{{ t.settlement_note }}</td>
            </tr>
            <tr v-if="!unsettled.length"><td colspan="7" class="empty">无待结清 ✅</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.stats { display: flex; flex-direction: column; gap: 20px; }
.toolbar { display: flex; gap: 8px; }
section { background: #fff; border-radius: 8px; padding: 12px 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
section h3 { margin: 0 0 10px; font-size: 15px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 8px; text-align: right; border-bottom: 1px solid #f0f1f3; white-space: nowrap; }
th { color: #888; font-weight: 600; font-size: 12px; }
td:first-child, th:first-child { text-align: left; }
.name { color: #3370ff; font-weight: 600; }
.in { color: #16a34a; }
.out { color: #d33; }
.muted { color: #aaa; font-weight: 400; }
.small { font-size: 12px; }
.tag { padding: 1px 6px; border-radius: 4px; background: #eef0f3; font-size: 11px; }
.tag.income { background: #e6f4ff; color: #1677ff; }
.tag.expense { background: #fff1f0; color: #d33; }
.empty { text-align: center; color: #aaa; padding: 18px; }
.error { color: #d33; }
button { padding: 6px 14px; border: none; background: #3370ff; color: #fff; border-radius: 6px; cursor: pointer; }
button:disabled { background: #aaa; }
</style>
