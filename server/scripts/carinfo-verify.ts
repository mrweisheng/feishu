/**
 * 车源检索(carinfo)链路验证脚本:不启动服务,只 outbound 调 carinfo API + 飞书 API。
 *
 * 验证内容(覆盖 search_cars 工具的完整真实链路):
 *   1. /search 自然语言检索(真实 key)
 *   2. /vehicle/{id} 详情取图片列表
 *   3. 下载前 2 张图(完整链路会取前 6 张,这里省流量)
 *   4. im/v1/images 上传换 image_key
 *   5. 把一条真实数据的测试车卡发到「机器人测试群」(PLATES_OUTPUT_CHAT_ID,
 *      与靓号海报同一个测试群,不打扰任何业务群)
 *
 * 注意:reply(引用回复)端点与 send 端点用的是同一套 post content 形状,
 * 真正的「引用用户提问」由线上 askLLM 链路验证;本脚本验证的是内容构造与
 * 图片上传链路本身。
 *
 * 用法:
 *   cd server && npm run carinfo:verify -- "五十万以内的阿尔法"
 *   (不带参数默认查「五十万以内的阿尔法 一手」)
 */
import 'dotenv/config'
import { config } from '../src/config.js'
import { apiClient } from '../src/feishu/client.js'
import {
  searchCars,
  getCarDetail,
  downloadCarImage,
  formatCarCardLines,
  buildCarPostContent,
} from '../src/services/carinfo.js'
import { uploadFeishuImage } from '../src/feishu/messages.js'

async function main() {
  const query = process.argv[2] || '五十万以内的阿尔法 一手'
  console.log(`🔍 验证搜车链路,query:「${query}」`)
  console.log(`   carinfo: ${config.CARINFO_API_BASE} | 测试群: ${config.PLATES_OUTPUT_CHAT_ID}`)

  // 1) 检索
  const search = await searchCars(query, 1)
  const item = search.items?.[0]
  if (!item) {
    console.log('ℹ️ 检索返回 0 条(total_matched=' + search.total_matched + '),链路本身正常')
    return
  }
  console.log(`✅ /search ok:${item.car_model} ${item.price_text ?? ''}(total_matched=${search.total_matched}, parse_source=${search.parse_source})`)

  // 2) 详情
  const detail = await getCarDetail(item.vehicle_id)
  const images = detail.images ?? []
  console.log(`✅ /vehicle ok:images ${images.length} 张, description ${detail.description ? '有' : '无'}, transmission=${detail.transmission ?? '—'}`)

  // 3) 下载前 2 张(验证 CDN 可达 + 格式转换)
  const picked = images.slice(0, 2)
  const bufs: Buffer[] = []
  for (const url of picked) {
    const buf = await downloadCarImage(url)
    if (!buf) throw new Error(`图片下载失败:${url}`)
    bufs.push(buf)
    console.log(`✅ 图片下载 ok:${buf.length} bytes`)
  }

  // 4) 上传飞书
  const keys: string[] = []
  for (const buf of bufs) {
    const key = await uploadFeishuImage(buf)
    keys.push(key)
    console.log(`✅ 飞书上传 ok:image_key=${key}`)
  }

  // 5) 发测试车卡到机器人测试群(send 端点;content 与 reply 完全同形)
  const lines = formatCarCardLines(item, detail)
  const content = buildCarPostContent('', lines, item.car_url ?? null, keys)
  // send 端点与 replyPostRich 的差异只在 endpoint,content 复用同一构造函数
  // 空 userOpenId 时首段只有标题文字,不再单独 @
  if (!content.zh_cn.content[0].some((r: any) => r.tag === 'at')) {
    content.zh_cn.content[0] = [{ tag: 'text', text: `🧪(链路验证)${content.zh_cn.content[0].filter((r: any) => r.tag === 'text').map((r: any) => r.text).join('')}` }]
  }
  await apiClient.request({
    method: 'POST',
    url: '/open-apis/im/v1/messages?receive_id_type=chat_id',
    data: {
      receive_id: config.PLATES_OUTPUT_CHAT_ID,
      msg_type: 'post',
      content: JSON.stringify(content),
    },
  })
  console.log('✅ 测试车卡已发到机器人测试群,去群里看效果(标题/价格/比价/配置/行情/原帖链接/图片)')
  console.log('\n📋 卡片行预览:')
  for (const line of lines) console.log('  ', line)
}

main()
  .then(() => process.exit(0))
  .catch((err: any) => {
    console.error('❌ 验证失败:', err?.stack ?? err?.message ?? err)
    process.exit(1)
  })
