// 天气查询服务:封装对 wttr.in 的调用,供 LLM 工具使用。
// wttr.in 免费无需 key,支持中文城市名查询,format=j1 返回结构化 JSON。
// 同一份响应里既有 current_condition(实时)又有 weather[](未来3天预报)。
// 这里只做「调外部 API + 字段适配」,不存数据(天气是实时/预报查询,无需落库)。
//
// ⚠️ 已知坑:wttr.in 对中文城市名解析**间歇性失败**——绝大多数时候能正确识别
// (返回该城市 + country=China),但偶发会返回一个毫不相干的地点(如「武汉」
// 被解析成法国 Rennes)。若不加校验,LLM 会拿到错误地点的温度糊弄用户。
// 解法:见 fetchWeather 的「国家校验 + 重试」。

// wttr.in 的 weatherCode → 中文描述映射(主要码,未覆盖的回退用英文 desc)
const WEATHER_CODE_CN: Record<string, string> = {
  113: '晴',
  116: '多云',
  119: '阴',
  122: '浓阴',
  143: '薄雾',
  176: '小雨(局部)',
  179: '雨夹雪(局部)',
  182: '雨夹雪',
  185: '冻雨',
  200: '雷阵雨(局部)',
  227: '小雪',
  230: '暴雪',
  248: '雾',
  260: '冻雾',
  263: '毛毛雨',
  266: '小雨',
  281: '冻毛毛雨',
  284: '冻雨',
  293: '小雨(局部)',
  296: '小雨',
  299: '中雨',
  302: '中雨',
  305: '大雨',
  308: '暴雨',
  311: '冻雨',
  314: '冻雨(大)',
  317: '雨夹雪',
  320: '小雪',
  323: '中雪',
  326: '大雪',
  329: '暴雪',
  332: '暴雪',
  335: '大暴雪',
  338: '大暴雪',
  350: '冻雨',
  353: '小雨(局部)',
  356: '大雨',
  359: '暴雨',
  362: '雨夹雪',
  365: '雨夹雪(大)',
  368: '小雪',
  371: '大雪',
  374: '冻雨(大)',
  377: '冻雨(大)',
  386: '雷阵雨(局部)',
  389: '雷阵雨',
  392: '阵雪(局部)',
  395: '阵雪(大)',
}

export interface WeatherInfo {
  city: string
  date?: string // 查询的日期(YYYY-MM-DD);不传=当前实时
  isForecast: boolean // true=预报,false=当前实时
  temperature: string // 实时:实际温度;预报:最高/最低如"34/26"。给 LLM 看的主温度
  feelsLike?: string // 实时体感温度(预报无此字段)。实际温度与体感可能差很多(如34°体感44°),LLM 需区分报给用户
  description: string // 天气描述,如 "晴"
  humidity: string // 湿度百分比
  wind: string // 风速 km/h
}

function describe(code: string, node: any): string {
  return WEATHER_CODE_CN[code] || node?.lang_zh?.[0]?.value || node?.weatherDesc?.[0]?.value || '未知'
}

// 中文城市名正则:含 CJK 字符 → 认定为中文查询,需要国家校验(只认 China)
const CN_CITY_RE = /[\u4e00-\u9fff]/

/**
 * 调一次 wttr.in 并返回完整 JSON。
 * 中文城市名查询时做「国家校验」:wttr.in 偶发把中文城市解析到错误地点(如「武汉」→法国
 * Rennes)。中文城市的正确结果 country 应为 China;若不是,视为解析失败让调用方重试。
 * @returns 完整 wttr.in JSON;country 不符(仅中文查询时)抛错触发重试
 */
async function fetchWeather(city: string): Promise<any> {
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`天气接口返回 ${res.status}`)
  const data: any = await res.json()
  // 中文城市名校验:返回的国家不是 China,大概率是解析到了错误地点
  if (CN_CITY_RE.test(city)) {
    const country = data?.nearest_area?.[0]?.country?.[0]?.value
    if (country && country !== 'China') {
      const area = data?.nearest_area?.[0]?.areaName?.[0]?.value
      throw new Error(`城市解析可疑:查「${city}」却返回「${area}, ${country}」,可能是 wttr.in 间歇性解析失败`)
    }
  }
  return data
}

/**
 * 带重试的天气拉取:wttr.in 对中文城市名解析间歇性失败(返回错误地点),单次失败时
 * 重试最多 3 次,每次间隔 600ms。三次都返回可疑地点才放弃并抛最后一个错误。
 */
async function fetchWeatherWithRetry(city: string): Promise<any> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetchWeather(city)
    } catch (err: any) {
      lastErr = err
      // 仅「国家校验失败」这种数据问题才值得重试(网络/超时错误重试也行,但不必细分)
      if (attempt < 3) await new Promise((r) => setTimeout(r, 600))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('天气查询失败')
}

/**
 * 查询某城市天气。
 * @param city 城市名,中文或英文,如"武汉"、"上海"
 * @param date 可选,ISO 日期 YYYY-MM-DD。传了查该日预报;不传查当前实时。
 *   wttr.in 免费版预报范围约未来 3 天,超出范围会抛错由调用方兜底。
 * @throws 网络错误 / 解析失败 / 日期超出预报范围 时抛出
 */
export async function getWeather(city: string, date?: string): Promise<WeatherInfo> {
  const data: any = await fetchWeatherWithRetry(city)
  const cityName = data?.nearest_area?.[0]?.areaName?.[0]?.value || city

  // ---- 不传 date:返回当前实时 ----
  if (!date) {
    const current = data?.current_condition?.[0]
    if (!current) throw new Error('天气接口返回缺少 current_condition')
    return {
      city: cityName,
      isForecast: false,
      temperature: String(current.temp_C ?? ''), // 实际温度,报给用户的主温度
      feelsLike: String(current.FeelsLikeC ?? ''), // 体感温度(高温高湿时比实际高很多,需告知用户)
      description: describe(String(current.weatherCode), current),
      humidity: String(current.humidity ?? ''),
      wind: String(current.windspeedKmph ?? ''),
    }
  }

  // ---- 传了 date:在 weather[] 里找匹配那天 ----
  // weather[].date 格式 YYYY-MM-DD;hourly[] 每 3 小时一段,noonIndex=4(约12点)代表白天
  const days = Array.isArray(data?.weather) ? data.weather : []
  const target = days.find((d: any) => d.date === date)
  if (!target) {
    const available = days.map((d: any) => d.date).join(', ')
    throw new Error(`无法查询 ${date} 的天气,wttr.in 预报范围外的日期。可查日期:${available || '无'}`)
  }

  // 取白天时段(hourly 数组第 4 段 ~ 1200)代表当天天气;取不到就用第 0 段
  const hourly = Array.isArray(target.hourly) ? target.hourly : []
  const noon = hourly[4] || hourly[0]
  if (!noon) throw new Error(`${date} 预报数据缺少 hourly 字段`)

  return {
    city: cityName,
    date,
    isForecast: true,
    temperature: `${target.maxtempC}/${target.mintempC}`, // 最高/最低
    description: describe(String(noon.weatherCode), noon),
    humidity: String(noon.humidity ?? ''),
    wind: String(noon.windspeedKmph ?? ''),
  }
}

export interface ForecastDay {
  date: string // YYYY-MM-DD
  weekday: string // 周几
  temperature: string // 最高/最低
  description: string // 天气描述
  humidity: string
  wind: string
}

/**
 * 查询某城市未来 N 天逐日预报(N 不传默认返回全部,wttr.in 免费版最多 3 天:今天/明天/后天)。
 * 用户问"接下来天气""未来几天天气""这周天气"时用本函数一次性拿全部可查天数。
 * @param city 城市名
 * @param days 最多返回几天(默认全部,即 3)
 */
export async function getWeatherForecast(city: string, days?: number): Promise<{ city: string; days: ForecastDay[] }> {
  const data: any = await fetchWeatherWithRetry(city)
  const cityName = data?.nearest_area?.[0]?.areaName?.[0]?.value || city

  const all = (Array.isArray(data?.weather) ? data.weather : []) as any[]
  if (!all.length) throw new Error('天气接口未返回预报数据')
  const limited = typeof days === 'number' && days > 0 ? all.slice(0, days) : all

  const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const out: ForecastDay[] = limited.map((d) => {
    const hourly = Array.isArray(d.hourly) ? d.hourly : []
    const noon = hourly[4] || hourly[0]
    const wd = isNaN(Date.parse(d.date)) ? '' : weekdayNames[new Date(d.date).getDay()]
    return {
      date: d.date,
      weekday: wd,
      temperature: `${d.maxtempC}/${d.mintempC}`,
      description: noon ? describe(String(noon.weatherCode), noon) : '未知',
      humidity: String(noon?.humidity ?? ''),
      wind: String(noon?.windspeedKmph ?? ''),
    }
  })
  return { city: cityName, days: out }
}
