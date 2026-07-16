// 天气查询服务:封装对 open-meteo 的调用,供 LLM 工具使用。
//
// 为什么不用 wttr.in:它对中文城市名解析间歇性失败(「香港」直接 500 location not found,
// 「武汉」偶发被解析到法国),且 8s 超时频发。
//
// open-meteo(https://open-meteo.com)优势:
// - 完全免费、无需 API key、无调用配额(非商业用途每天 1 万次)
// - geocoding API 原生支持中文城市名(香港/武汉/北京都秒解,返回坐标)
// - 一次请求同时拿实时(current)+ 多日预报(daily),无需两次往返
// - 数据齐全:实际温度 + 体感温度(apparent_temperature)+ 湿度 + 风速 + WMO 天气码
//
// 两步查询:① geocoding 把城市名→经纬度(带缓存,同一城市不重复查);② 用经纬度查天气。

// WMO 标准天气代码 → 中文描述(open-meteo 用 WMO code,和 wttr.in 的私有码不同)
// 完整表见 https://open-meteo.com/en/docs WMO Weather interpretation codes
const WMO_CODE_CN: Record<number, string> = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '冻雾',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '毛毛雨(密)',
  56: '冻毛毛雨',
  57: '冻毛毛雨(密)',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '冻雨(大)',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '米雪',
  80: '阵雨',
  81: '中阵雨',
  82: '强阵雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '强雷阵雨伴冰雹',
}

function describeWmo(code: number | undefined): string {
  if (code === undefined || code === null) return '未知'
  return WMO_CODE_CN[code] || '未知'
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

// ---- 城市名 → 坐标缓存(进程内,同一城市不重复查 geocoding) ----
interface GeoResult {
  name: string // 解析出的标准城市名(中文,优先返回给用户)
  latitude: number
  longitude: number
  timezone: string
}
const geoCache = new Map<string, GeoResult>()

/**
 * 用 open-meteo geocoding 把城市名解析成坐标。
 * 支持中文/英文城市名(language=zh 优先返回中文名)。结果带缓存。
 * @throws 城市找不到 / 网络错误 时抛出
 */
async function geocode(city: string): Promise<GeoResult> {
  const cached = geoCache.get(city)
  if (cached) return cached

  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`城市查询接口返回 ${res.status}`)
  const data: any = await res.json()
  const hit = data?.results?.[0]
  if (!hit) throw new Error(`找不到城市「${city}」`)

  const result: GeoResult = {
    name: hit.name || city,
    latitude: hit.latitude,
    longitude: hit.longitude,
    timezone: hit.timezone || 'Asia/Shanghai',
  }
  geoCache.set(city, result)
  return result
}

// open-meteo 一次请求拿实时 + 多日预报所需的字段。
// current:实际温度/体感/湿度/风速/WMO码;daily:每天最高最低温/WMO码/湿度/风速
const WEATHER_PARAMS =
  'current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
  '&daily=weather_code,temperature_2m_max,temperature_2m_min,relative_humidity_2m_max,wind_speed_10m_max'

interface WeatherData {
  cityName: string
  current: {
    temperature: number
    feelsLike: number
    humidity: number
    wind: number
    code: number
  }
  daily: Array<{
    date: string
    max: number
    min: number
    humidity: number
    wind: number
    code: number
  }>
}

/**
 * 一次请求拿到实时 + 预报(默认 3 天)。open-meteo 单请求同时返回 current 和 daily。
 * 带重试:网络/超时类瞬时错误重试最多 3 次(间隔 500ms)。
 */
async function fetchWeather(city: string, forecastDays = 3): Promise<WeatherData> {
  const geo = await geocode(city)
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}&${WEATHER_PARAMS}&timezone=${encodeURIComponent(geo.timezone)}&forecast_days=${forecastDays}`

  let lastErr: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`天气接口返回 ${res.status}`)
      const data: any = await res.json()

      const cur = data?.current
      if (!cur) throw new Error('天气接口未返回 current 数据')
      const daily = data?.daily
      if (!daily) throw new Error('天气接口未返回 daily 数据')

      const dailyArr: WeatherData['daily'] = []
      const len = Array.isArray(daily.time) ? daily.time.length : 0
      for (let i = 0; i < len; i++) {
        dailyArr.push({
          date: daily.time[i],
          max: daily.temperature_2m_max?.[i],
          min: daily.temperature_2m_min?.[i],
          humidity: daily.relative_humidity_2m_max?.[i],
          wind: daily.wind_speed_10m_max?.[i],
          code: daily.weather_code?.[i],
        })
      }

      return {
        cityName: geo.name,
        current: {
          temperature: cur.temperature_2m,
          feelsLike: cur.apparent_temperature,
          humidity: cur.relative_humidity_2m,
          wind: cur.wind_speed_10m,
          code: cur.weather_code,
        },
        daily: dailyArr,
      }
    } catch (err: any) {
      lastErr = err
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('天气查询失败')
}

/**
 * 查询某城市天气。
 * @param city 城市名,中文或英文,如"武汉"、"香港"、"Hong Kong"
 * @param date 可选,ISO 日期 YYYY-MM-DD。传了查该日预报;不传查当前实时。
 *   open-meteo 免费版预报范围约未来 16 天,但 LLM 工具限制最多 3 天,超出会抛错。
 * @throws 网络错误 / 找不到城市 / 日期超出预报范围 时抛出
 */
export async function getWeather(city: string, date?: string): Promise<WeatherInfo> {
  const data = await fetchWeather(city, 3)

  // ---- 不传 date:返回当前实时 ----
  if (!date) {
    return {
      city: data.cityName,
      isForecast: false,
      temperature: String(data.current.temperature ?? ''),
      feelsLike: String(data.current.feelsLike ?? ''),
      description: describeWmo(data.current.code),
      humidity: String(data.current.humidity ?? ''),
      wind: String(data.current.wind ?? ''),
    }
  }

  // ---- 传了 date:在 daily[] 里找匹配那天 ----
  const target = data.daily.find((d) => d.date === date)
  if (!target) {
    const available = data.daily.map((d) => d.date).join(', ')
    throw new Error(`无法查询 ${date} 的天气,预报范围外的日期。可查日期:${available || '无'}`)
  }

  return {
    city: data.cityName,
    date,
    isForecast: true,
    temperature: `${target.max}/${target.min}`, // 最高/最低
    description: describeWmo(target.code),
    humidity: String(target.humidity ?? ''),
    wind: String(target.wind ?? ''),
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
 * 查询某城市未来 N 天逐日预报(N 不传默认返回全部,最多 3 天:今天/明天/后天)。
 * 用户问"接下来天气""未来几天天气""这周天气"时用本函数一次性拿全部可查天数。
 * @param city 城市名
 * @param days 最多返回几天(默认全部,即 3)
 */
export async function getWeatherForecast(city: string, days?: number): Promise<{ city: string; days: ForecastDay[] }> {
  const data = await fetchWeather(city, 3)
  if (!data.daily.length) throw new Error('天气接口未返回预报数据')

  const limited = typeof days === 'number' && days > 0 ? data.daily.slice(0, days) : data.daily
  const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

  const out: ForecastDay[] = limited.map((d) => {
    const wd = isNaN(Date.parse(d.date)) ? '' : weekdayNames[new Date(d.date).getDay()]
    return {
      date: d.date,
      weekday: wd,
      temperature: `${d.max}/${d.min}`,
      description: describeWmo(d.code),
      humidity: String(d.humidity ?? ''),
      wind: String(d.wind ?? ''),
    }
  })
  return { city: data.cityName, days: out }
}
