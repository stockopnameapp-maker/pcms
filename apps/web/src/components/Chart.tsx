import ReactECharts from 'echarts-for-react';

// Palette ordered for distinguishability on white: canopy, kernel gold, slate blue, clay, sage, plum
export const SERIES = ['#1F6B4F', '#B38B2E', '#3B6E8F', '#B4532A', '#7FA88E', '#7A4E7E'];
const base = {
  textStyle: { fontFamily: 'IBM Plex Sans, system-ui, sans-serif', color: '#3F4A45' },
  grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
  tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#E1E6E3', textStyle: { color: '#17211C', fontSize: 12.5 } },
};
const axis = { axisLine: { lineStyle: { color: '#E1E6E3' } }, axisTick: { show: false }, axisLabel: { color: '#5E6B65', fontSize: 11.5 }, splitLine: { lineStyle: { color: '#EEF1EF' } } };

export function LineChart({ data, x, series, height = 240, area, money }: { data: any[]; x: string; series: { key: string; name: string }[]; height?: number; area?: boolean; money?: boolean }) {
  const option = {
    ...base, color: SERIES,
    legend: series.length > 1 ? { top: 0, right: 0, itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 12 } } : undefined,
    xAxis: { type: 'category', data: data.map((d) => d[x]), ...axis, boundaryGap: false },
    yAxis: { type: 'value', ...axis, axisLabel: { ...axis.axisLabel, formatter: money ? (v: number) => (v >= 1e6 ? (v / 1e6).toFixed(0) + ' jt' : v.toLocaleString('id-ID')) : undefined } },
    series: series.map((s, i) => ({ type: 'line', name: s.name, data: data.map((d) => d[s.key]), smooth: 0.25, symbol: 'circle', symbolSize: 5, lineStyle: { width: 2 },
      areaStyle: area && i === 0 ? { opacity: 0.08 } : undefined })),
  };
  return <ReactECharts option={option} style={{ height }} notMerge />;
}

export function BarChart({ data, x, y, height = 260, horizontal, color = SERIES[0], money, name }: { data: any[]; x: string; y: string; height?: number; horizontal?: boolean; color?: string; money?: boolean; name?: string }) {
  const cat = { type: 'category', data: data.map((d) => d[x]), ...axis, axisLabel: { ...axis.axisLabel, width: 150, overflow: 'truncate' } };
  const val = { type: 'value', ...axis, axisLabel: { ...axis.axisLabel, formatter: money ? (v: number) => (v >= 1e9 ? (v / 1e9).toFixed(1) + ' M' : v >= 1e6 ? (v / 1e6).toFixed(0) + ' jt' : v) : undefined } };
  const option = {
    ...base, color: [color], tooltip: { ...base.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: horizontal ? val : cat, yAxis: horizontal ? { ...cat, inverse: true } : val,
    series: [{ type: 'bar', name, data: data.map((d) => d[y]), barMaxWidth: 22, itemStyle: { borderRadius: horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0] } }],
  };
  return <ReactECharts option={option} style={{ height }} notMerge />;
}

export function DonutChart({ data, height = 220 }: { data: { name: string; value: number; color?: string }[]; height?: number }) {
  const option = {
    ...base, tooltip: { trigger: 'item', backgroundColor: '#fff', borderColor: '#E1E6E3', textStyle: { color: '#17211C', fontSize: 12.5 } },
    legend: { orient: 'vertical', right: 0, top: 'middle', itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 12 } },
    series: [{ type: 'pie', radius: ['55%', '80%'], center: ['32%', '50%'], avoidLabelOverlap: true, label: { show: false },
      itemStyle: { borderColor: '#fff', borderWidth: 2 }, data: data.map((d, i) => ({ ...d, itemStyle: { color: d.color ?? SERIES[i % SERIES.length] } })) }],
  };
  return <ReactECharts option={option} style={{ height }} notMerge />;
}
