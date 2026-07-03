<script setup lang="ts">
import type { MessageItem } from '../api'

defineProps<{ items: MessageItem[] }>()

function time(t: number | null): string {
  return t ? new Date(t).toLocaleString() : ''
}

function text(content: string | null): string {
  if (!content) return '[空]'
  try {
    const obj = JSON.parse(content)
    return obj.text || '[非文本消息]'
  } catch {
    return '[非文本消息]'
  }
}
</script>

<template>
  <ul class="list">
    <li v-for="m in items" :key="m.message_id">
      <div class="meta">
        <span class="name">{{ m.sender_name || '未知用户' }}</span>
        <span class="time">{{ time(m.create_time) }}</span>
        <span class="src" :class="m.source">{{ m.source }}</span>
      </div>
      <div class="content">{{ text(m.content) }}</div>
    </li>
    <li v-if="!items.length" class="empty">暂无消息</li>
  </ul>
</template>

<style scoped>
.list { list-style: none; padding: 0; margin: 0; }
li { background: #fff; border-radius: 8px; padding: 12px 14px; margin-bottom: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
.meta { display: flex; align-items: center; gap: 10px; font-size: 12px; color: #888; margin-bottom: 6px; }
.name { color: #3370ff; font-weight: 600; font-size: 13px; }
.src { padding: 1px 6px; border-radius: 4px; background: #eef0f3; font-size: 11px; }
.src.realtime { background: #e6f4ff; color: #1677ff; }
.content { font-size: 14px; line-height: 1.5; word-break: break-all; }
.empty { text-align: center; color: #aaa; padding: 32px; }
</style>
