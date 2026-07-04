import Database from 'better-sqlite3'
import { summaryByDirection } from './src/db/transactions.js'
const db = new Database('./data/messages.db', { readonly: true })
console.log('== transactions ==')
console.table(db.prepare('SELECT id,direction,kind,occurred_at,amount_minor,currency,our_account,counterparty_name,counterparty_account_type,project_id,feishu_record_id,settlement_status,settlement_note,project_name_raw FROM transactions').all())
console.log('== projects ==')
console.table(db.prepare('SELECT * FROM projects').all())
console.log('== payment_methods ==')
console.table(db.prepare('SELECT key,label,currency FROM payment_methods ORDER BY key').all())
console.log('== 收入累计 ==', summaryByDirection('income'))
console.log('== 转出累计 ==', summaryByDirection('expense'))
