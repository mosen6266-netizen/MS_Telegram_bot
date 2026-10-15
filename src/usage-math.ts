export type UsagePoint = {
  used: number;
  quota: number | null;
  period_start: string;
  period_end: string;
  observed_at: string;
  source: string;
};

export function monthPeriod(at: Date, billingDay = 1) {
  function boundary(year: number, month: number) {
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(billingDay, last)));
  }
  let start = boundary(at.getUTCFullYear(), at.getUTCMonth());
  if (start > at) start = boundary(at.getUTCFullYear(), at.getUTCMonth() - 1);
  const end = boundary(start.getUTCFullYear(), start.getUTCMonth() + 1);
  return {start: start.toISOString(), end: end.toISOString()};
}

export function dayPeriod(at: Date) {
  const start = new Date(at.toISOString().slice(0, 10) + "T00:00:00.000Z");
  return {start: start.toISOString(), end: new Date(+start + 86400000).toISOString()};
}

export function assessUsage(point: UsagePoint, previous: UsagePoint | null, at: Date) {
  const quota = point.quota;
  const current = Date.parse(point.observed_at);
  const age = +at - current;
  const valid = Number.isFinite(point.used) && point.used >= 0 &&
    Number.isFinite(current) && age >= -60000 && age <= 45 * 60000 &&
    +at >= Date.parse(point.period_start) && +at < Date.parse(point.period_end);
  const hasLimit = typeof quota === "number" && Number.isFinite(quota) && quota > 0;
  const remaining = hasLimit ? Math.max(0, quota - point.used) : null;
  // Only compare observations from the same meter, source and billing period.
  // Requiring real elapsed time avoids treating a new installation as seven days of zero use.
  const elapsed = previous ? current - Date.parse(previous.observed_at) : 0;
  const rate = previous && elapsed >= 15 * 60000 && elapsed <= 8 * 86400000 &&
    previous.period_start === point.period_start && previous.source === point.source &&
    point.used >= previous.used ? (point.used - previous.used) / elapsed : null;
  const exhaustMs = rate && rate > 0 && remaining !== null ? remaining / rate : null;
  const untilReset = Date.parse(point.period_end) - current;
  const threshold = valid && hasLimit && point.used / quota >= 0.8;
  const forecast = valid && exhaustMs !== null && exhaustMs <= 7 * 86400000 &&
    exhaustMs < untilReset;
  return {
    fresh: valid,
    remaining,
    percentage: hasLimit ? Math.round(point.used / quota * 1000) / 10 : null,
    predicted_exhaust_days: exhaustMs === null ? null : Math.round(exhaustMs / 8640000) / 10,
    threshold_alert: threshold,
    forecast_alert: forecast,
    forecast_ready: rate !== null
  };
}

function nonnegative(value: unknown, name: string) {
  const result = typeof value === "number" || typeof value === "string" && value.trim() !== ""
    ? Number(value) : NaN;
  if (!Number.isFinite(result) || result < 0) throw Error("平台返回了无效的 " + name);
  return result;
}

export function parseAlchemySummary(response: unknown) {
  const data = (response as {data?: Record<string, any>})?.data;
  const limitData = data?.usageLimit;
  const total = data?.totals?.monthToDate;
  if (!data?.billingPeriod || !limitData && !total) throw Error("Alchemy 用量响应不完整");
  if (limitData ? limitData.unit && limitData.unit !== "CU" : !["CU", "ALCHEMY_COMPUTE_UNIT"].includes(total?.unit))
    throw Error("Alchemy 返回了非 CU 用量，不能用于 CU 额度预警");
  const start = new Date(data.billingPeriod.startTime);
  const end = new Date(data.billingPeriod.endTime);
  const observed = new Date(data.freshness?.dataThrough);
  if (![+start, +end, +observed].every(Number.isFinite) || end <= start)
    throw Error("Alchemy 未返回有效的账期或数据时间");
  const used = nonnegative(limitData ? limitData.used : total.amount, "Alchemy CU");
  const limit = !limitData || limitData.limit === null ? null : nonnegative(limitData.limit, "Alchemy 额度");
  const usd = data.totals?.monthToDate?.usd;
  return {
    metric: "alchemy_cu", used, quota: limit && limit > 0 ? limit : null,
    unit: "CU", period_start: start.toISOString(), period_end: end.toISOString(),
    observed_at: observed.toISOString(), source: "official_api", scope: "Alchemy 整个团队",
    extra: {usd: usd === undefined ? null : nonnegative(usd, "Alchemy 费用"),
      quota_source: limitData ? "official_api" : "not_returned",
      note: limitData ? "平台聚合数据可能有延迟" : "官方 API 未返回额度，请按当前套餐确认 CU 额度"}
  };
}

export function cloudflareDayQuery(account: string, day: string) {
  if (!/^[a-f0-9]{32}$/.test(account) || !/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw Error("Cloudflare 账号或日期无效");
  const start = day + "T00:00:00Z";
  const end = new Date(Date.parse(start) + 86400000).toISOString();
  const time = "datetime_geq:" + JSON.stringify(start) + ",datetime_lt:" + JSON.stringify(end);
  const date = "date_geq:" + JSON.stringify(day) + ",date_leq:" + JSON.stringify(day);
  return "{viewer{accounts(filter:{accountTag:" + JSON.stringify(account) + "}){" +
    "workers:workersInvocationsAdaptive(limit:1,filter:{" + time + "}){sum{requests cpuTimeUs}}" +
    "d1:d1AnalyticsAdaptiveGroups(limit:1,filter:{" + date + "}){sum{rowsRead rowsWritten}}" +
    "queues:queueMessageOperationsAdaptiveGroups(limit:1,filter:{" + time + "}){sum{billableOperations}}" +
    "storage:d1StorageAdaptiveGroups(limit:10000,filter:{" + date + "}){dimensions{databaseId}max{databaseSizeBytes}}" +
    "}}}";
}

export function parseCloudflareDay(response: unknown) {
  const body = response as {data?: {viewer?: {accounts?: Array<Record<string, any>>}}, errors?: unknown[]};
  const account = body.data?.viewer?.accounts?.[0];
  if (!account || body.errors?.length) throw Error("Cloudflare 未返回完整统计，请检查 Analytics 读取权限和查询范围");
  for (const key of ["workers", "d1", "queues", "storage"]) {
    if (!Array.isArray(account[key])) throw Error("Cloudflare 缺少 " + key + " 统计");
  }
  const sum = (rows: Array<Record<string, any>>, key: string) =>
    rows.reduce((n, r) => n + nonnegative(r.sum?.[key], key), 0);
  if (account.storage.length >= 10000) throw Error("D1 存储统计达到分页上限，不能作为完整用量");
  return {
    workers_requests: sum(account.workers, "requests"),
    workers_cpu_ms: sum(account.workers, "cpuTimeUs") / 1000,
    d1_reads: sum(account.d1, "rowsRead"),
    d1_writes: sum(account.d1, "rowsWritten"),
    queue_ops: sum(account.queues, "billableOperations"),
    d1_storage_bytes: account.storage.reduce((n: number, r: Record<string, any>) =>
      n + nonnegative(r.max?.databaseSizeBytes, "D1 存储"), 0)
  };
}
