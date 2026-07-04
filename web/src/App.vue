<script setup lang="ts">
import { onMounted, ref } from 'vue'
import MessageList from './components/MessageList.vue'
import StatsView from './components/StatsView.vue'
import { fetchMessages, type MessageItem } from './api'

const tab = ref<'stats' | 'messages'>('stats')

const items = ref<MessageItem[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref('')

async function loadMessages() {
  loading.value = true
  error.value = ''
  try {
    const data = await fetchMessages({ limit: 100 })
    items.value = data.items
    total.value = data.total
  } catch (e: any) {
    error.value = e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(loadMessages)
</script>

<template>
  <div class="page">
    <header>
      <h1>飞书消息归档</h1>
      <nav class="tabs">
        <button :class="{ active: tab === 'stats' }" @click="tab = 'stats'">收支统计</button>
        <button :class="{ active: tab === 'messages' }" @click="tab = 'messages'">消息</button>
      </nav>
      <template v-if="tab === 'messages'">
        <button class="refresh" @click="loadMessages" :disabled="loading">{{ loading ? '加载中...' : '刷新' }}</button>
        <span class="count">共 {{ total }} 条</span>
      </template>
    </header>
    <p v-if="error" class="error">{{ error }}</p>
    <StatsView v-show="tab === 'stats'" />
    <MessageList v-if="tab === 'messages'" :items="items" />
  </div>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f5f6f8; }
.page { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
header h1 { font-size: 20px; margin: 0; }
.count { color: #888; font-size: 14px; }
button { padding: 6px 14px; border: none; background: #3370ff; color: #fff; border-radius: 6px; cursor: pointer; }
button:disabled { background: #aaa; }
.tabs { display: inline-flex; gap: 4px; }
.tabs button { background: #eef0f3; color: #555; }
.tabs button.active { background: #3370ff; color: #fff; }
.refresh { background: #3370ff; }
.error { color: #d33; }
</style>
