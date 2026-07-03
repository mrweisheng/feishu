<script setup lang="ts">
import { onMounted, ref } from 'vue'
import MessageList from './components/MessageList.vue'
import { fetchMessages, type MessageItem } from './api'

const items = ref<MessageItem[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref('')

async function load() {
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

onMounted(load)
</script>

<template>
  <div class="page">
    <header>
      <h1>飞书消息归档</h1>
      <button @click="load" :disabled="loading">{{ loading ? '加载中...' : '刷新' }}</button>
      <span class="count">共 {{ total }} 条</span>
    </header>
    <p v-if="error" class="error">{{ error }}</p>
    <MessageList :items="items" />
  </div>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f5f6f8; }
.page { max-width: 800px; margin: 0 auto; padding: 24px 16px; }
header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
header h1 { font-size: 20px; margin: 0; }
.count { color: #888; font-size: 14px; }
button { padding: 6px 14px; border: none; background: #3370ff; color: #fff; border-radius: 6px; cursor: pointer; }
button:disabled { background: #aaa; }
.error { color: #d33; }
</style>
