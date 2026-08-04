import { appConfig } from "../config";

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  source: string;
};

type SearchProvider = "serper" | "brave" | "tavily" | "duckduckgo";
type SearchProgressReporter = (title: string, detail: string, kind?: string) => void;

const freshInfoPattern =
  /(最新|现在|目前|今天|昨日|昨天|明天|本周|本月|今年|实时|联网|搜索|查询|查一下|新闻|赛程|赛果|比分|排名|积分榜|淘汰赛|世界杯|欧洲杯|欧冠|英超|NBA|股票|汇率|天气|价格|行情|币价|加密货币|现货|期货|最高价|最低价|波动率|current|latest|today|yesterday|news|score|schedule|standing|price|weather|world cup|2026|BTC|ETH|bitcoin|crypto|binance|volatility|ohlc|kline)/i;

const authoritativeDomains = new Map<string, number>([
  ["fifa.com", 140],
  ["olympics.com", 90],
  ["reuters.com", 80],
  ["apnews.com", 80],
  ["bbc.com", 70],
  ["espn.com", 65],
  ["cbssports.com", 55],
  ["foxsports.com", 55],
  ["theathletic.com", 55],
  ["wikipedia.org", 25]
]);

const lowQualityDomainPattern =
  /(tips\.gg|goaltimeguide\.com|wc2026cn\.com|2026footballnews\.com|casino|betting|odds|prediction|predictions|bookmaker|bookmakers)/i;

const stripHtml = (value: string): string =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();

const withTimeout = async (url: string, init: RequestInit = {}): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), appConfig.search.timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": appConfig.search.userAgent,
        ...(init.headers ?? {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
};

const normalizeUrl = (url: string | undefined): string => {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

const domainScore = (url: string): number => {
  const host = hostOf(url);
  if (!host) {
    return 0;
  }

  if (lowQualityDomainPattern.test(host)) {
    return -80;
  }

  for (const [domain, score] of authoritativeDomains) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      return score;
    }
  }

  return 0;
};

const textScore = (result: WebSearchResult, query: string): number => {
  const haystack = `${result.title} ${result.snippet} ${result.content ?? ""}`.toLowerCase();
  const queryLower = query.toLowerCase();
  let score = 0;

  if (queryLower.includes("2026") && haystack.includes("2026")) {
    score += 10;
  }
  if ((queryLower.includes("世界杯") || queryLower.includes("world cup")) && /世界杯|world cup/i.test(haystack)) {
    score += 12;
  }
  if ((queryLower.includes("淘汰赛") || queryLower.includes("knockout")) && /淘汰赛|knockout|round of 32|round of 16|quarter|semi|final/i.test(haystack)) {
    score += 20;
  }
  if (/赛果|结果|比分|results?|scores?|fixtures?|schedule/i.test(queryLower) && /赛果|结果|比分|results?|scores?|fixtures?|schedule/i.test(haystack)) {
    score += 15;
  }
  if (/完整|全部|所有|all|complete/i.test(queryLower) && /完整|全部|所有|all|complete|full/i.test(haystack)) {
    score += 6;
  }
  if (result.content) {
    score += 8;
  }

  return score;
};

const rankResults = (results: WebSearchResult[], query: string): WebSearchResult[] =>
  [...results].sort((left, right) => {
    const rightScore = domainScore(right.url) + textScore(right, query);
    const leftScore = domainScore(left.url) + textScore(left, query);
    return rightScore - leftScore;
  });

const uniqueResults = (
  results: WebSearchResult[],
  limit = appConfig.search.maxResults
): WebSearchResult[] => {
  const seen = new Set<string>();
  const next: WebSearchResult[] = [];

  for (const result of results) {
    const url = normalizeUrl(result.url);
    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    next.push({
      ...result,
      url,
      title: stripHtml(result.title).trim() || url,
      snippet: stripHtml(result.snippet).slice(0, 800)
    });
  }

  return next.slice(0, limit);
};

const requestedResultCount = (): number => Math.max(appConfig.search.maxResults * 2, 10);

const searchSerper = async (query: string): Promise<WebSearchResult[]> => {
  const response = await withTimeout("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": appConfig.search.serperApiKey
    },
    body: JSON.stringify({
      q: query,
      num: requestedResultCount(),
      hl: "zh-cn"
    })
  });

  if (!response.ok) {
    throw new Error(`Serper search failed with ${response.status}.`);
  }

  const data = (await response.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };

  return uniqueResults(
    (data.organic ?? []).map((item) => ({
      title: item.title ?? "",
      url: item.link ?? "",
      snippet: item.snippet ?? "",
      source: "Serper"
    })),
    requestedResultCount()
  );
};

const searchBrave = async (query: string): Promise<WebSearchResult[]> => {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(requestedResultCount()));
  url.searchParams.set("search_lang", "zh-hans");

  const response = await withTimeout(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": appConfig.search.braveApiKey
    }
  });

  if (!response.ok) {
    throw new Error(`Brave search failed with ${response.status}.`);
  }

  const data = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };

  return uniqueResults(
    (data.web?.results ?? []).map((item) => ({
      title: item.title ?? "",
      url: item.url ?? "",
      snippet: item.description ?? "",
      source: "Brave"
    })),
    requestedResultCount()
  );
};

const searchTavily = async (query: string): Promise<WebSearchResult[]> => {
  const response = await withTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      api_key: appConfig.search.tavilyApiKey,
      query,
      max_results: requestedResultCount(),
      search_depth: "basic"
    })
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed with ${response.status}.`);
  }

  const data = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  return uniqueResults(
    (data.results ?? []).map((item) => ({
      title: item.title ?? "",
      url: item.url ?? "",
      snippet: item.content ?? "",
      source: "Tavily"
    })),
    requestedResultCount()
  );
};

const searchDuckDuckGo = async (query: string): Promise<WebSearchResult[]> => {
  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);

  const response = await withTimeout(url.toString());
  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed with ${response.status}.`);
  }

  const html = await response.text();
  const results: WebSearchResult[] = [];
  const blocks = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)];

  for (const block of blocks) {
    const rawUrl = block[1].replaceAll("&amp;", "&");
    const redirectUrl = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    let resultUrl = redirectUrl;

    try {
      const parsed = new URL(redirectUrl);
      resultUrl = parsed.searchParams.get("uddg") ?? redirectUrl;
    } catch {
      resultUrl = redirectUrl;
    }

    results.push({
      title: stripHtml(block[2]),
      url: resultUrl,
      snippet: stripHtml(block[3]),
      source: "DuckDuckGo"
    });
  }

  return uniqueResults(results, requestedResultCount());
};

const selectProviders = (): SearchProvider[] => {
  if (appConfig.search.provider !== "auto") {
    return [appConfig.search.provider as SearchProvider];
  }

  return [
    ...(appConfig.search.serperApiKey ? (["serper"] as const) : []),
    ...(appConfig.search.braveApiKey ? (["brave"] as const) : []),
    ...(appConfig.search.tavilyApiKey ? (["tavily"] as const) : []),
    "duckduckgo"
  ];
};

const runProvider = (provider: SearchProvider, query: string): Promise<WebSearchResult[]> => {
  switch (provider) {
    case "serper":
      return searchSerper(query);
    case "brave":
      return searchBrave(query);
    case "tavily":
      return searchTavily(query);
    case "duckduckgo":
      return searchDuckDuckGo(query);
  }
};

const isWorldCup2026KnockoutQuery = (query: string): boolean =>
  /(2026|二零二六).*(世界杯|world cup|fifa).*(淘汰赛|knockout|赛果|结果|比分|scores?|results?|bracket)/i.test(query) ||
  /(淘汰赛|knockout).*(2026|二零二六).*(世界杯|world cup|fifa)/i.test(query);

const seedResultsForQuery = (query: string): WebSearchResult[] => {
  if (!isWorldCup2026KnockoutQuery(query)) {
    return [];
  }

  return [
    {
      title: "FIFA - World Cup 2026 knockout stage match schedule and bracket",
      url: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/knockout-stage-match-schedule-bracket",
      snippet: "Official FIFA knockout stage schedule and bracket for the FIFA World Cup 2026.",
      source: "Official seed"
    },
    {
      title: "FIFA - World Cup 2026 match schedule, fixtures and results",
      url: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/match-schedule-fixtures-results-teams-stadiums",
      snippet: "Official FIFA match schedule, fixtures and results page for the FIFA World Cup 2026.",
      source: "Official seed"
    },
    {
      title: "FIFA - World Cup 2026 scores and fixtures",
      url: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/scores-fixtures",
      snippet: "Official FIFA scores and fixtures page for the FIFA World Cup 2026.",
      source: "Official seed"
    },
    {
      title: "Olympics.com - 2026 FIFA World Cup schedule, results, scores and standings",
      url: "https://www.olympics.com/zh/news/fifa-world-cup-2026-schedule-results-scores-standings-list",
      snippet: "Olympics.com schedule, results, scores and standings list for the 2026 FIFA World Cup.",
      source: "Official seed"
    }
  ];
};

const buildSearchQueries = (query: string): string[] => {
  if (isWorldCup2026KnockoutQuery(query)) {
    return [
      "site:fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026 knockout stage match schedule bracket results",
      "site:fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026 scores fixtures knockout results",
      "2026 FIFA World Cup knockout stage all match results scores",
      `${query} FIFA official results`
    ].slice(0, appConfig.search.maxQueries);
  }

  const queries = [
    query,
    `${query} official`,
    `${query} latest`,
    `${query} results sources`
  ];

  return [...new Set(queries)].slice(0, appConfig.search.maxQueries);
};

const keywordsForExtraction = (query: string): string[] => {
  const base = [
    "result",
    "results",
    "score",
    "scores",
    "fixture",
    "fixtures",
    "schedule",
    "match",
    "matches",
    "bracket",
    "knockout",
    "round of 32",
    "round of 16",
    "quarter-final",
    "quarterfinal",
    "semi-final",
    "semifinal",
    "third-place",
    "final",
    "赛果",
    "结果",
    "比分",
    "赛程",
    "比赛",
    "对阵",
    "淘汰赛",
    "32强",
    "三十二强",
    "16强",
    "十六强",
    "八分之一",
    "四分之一",
    "半决赛",
    "季军",
    "决赛"
  ];

  if (isWorldCup2026KnockoutQuery(query)) {
    return [
      "FIFA World Cup 2026",
      "World Cup 2026",
      ...base,
      "世界杯",
      "Spain",
      "Argentina",
      "France",
      "西班牙",
      "阿根廷",
      "法国"
    ];
  }

  return [
    ...base,
    ...query
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 3)
  ];
};

const extractWorldCupKnockoutSection = (text: string): string => {
  const lower = text.toLowerCase();
  const startMarkers = [
    "fifa world cup 2026 – round of 32",
    "fifa world cup 2026 - round of 32",
    "fifa world cup 2026 round of 32",
    "round of 32 results",
    "round of 32 fixtures"
  ];
  const start = startMarkers
    .map((marker) => lower.indexOf(marker))
    .filter((position) => position >= 0)
    .sort((left, right) => left - right)[0];

  if (start === undefined) {
    return "";
  }

  const endMarkers = [
    "### highlights",
    "highlights col",
    "groups in focus",
    "world cup 2026 superstars",
    "related articles",
    "more from fifa"
  ];
  const end = endMarkers
    .map((marker) => lower.indexOf(marker, start + 1000))
    .filter((position) => position > start)
    .sort((left, right) => left - right)[0];

  return text.slice(start, end ?? undefined).trim();
};

const extractRelevantText = (text: string, query: string): string => {
  if (isWorldCup2026KnockoutQuery(query)) {
    const knockoutSection = extractWorldCupKnockoutSection(text);
    if (knockoutSection) {
      return knockoutSection.slice(0, appConfig.search.maxPageChars);
    }
  }

  if (text.length <= appConfig.search.maxPageChars) {
    return text;
  }

  const lower = text.toLowerCase();
  const windows: string[] = [];
  const seenPositions = new Set<number>();

  for (const keyword of keywordsForExtraction(query)) {
    const lowerKeyword = keyword.toLowerCase();
    let position = lower.indexOf(lowerKeyword);

    while (position !== -1 && windows.length < 12) {
      const bucket = Math.floor(position / 1200);
      if (!seenPositions.has(bucket)) {
        seenPositions.add(bucket);
        windows.push(text.slice(Math.max(0, position - 900), position + 2200));
      }

      position = lower.indexOf(lowerKeyword, position + lowerKeyword.length);
    }

    if (windows.length >= 12) {
      break;
    }
  }

  const extracted = windows.join("\n...\n").trim();
  return (extracted || text).slice(0, appConfig.search.maxPageChars);
};

const decodeScriptText = (value: string): string =>
  value
    .replace(/\\u0026/g, "&")
    .replace(/\\u002F/gi, "/")
    .replace(/\\u003C/gi, "<")
    .replace(/\\u003E/gi, ">")
    .replace(/\\n|\\r|\\t/g, " ")
    .replace(/\\"/g, "\"")
    .replace(/\s+/g, " ")
    .trim();

const extractStructuredPageText = (html: string, query: string): string => {
  const scriptBlocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  const keywords = isWorldCup2026KnockoutQuery(query)
    ? [
        "FIFA World Cup 2026",
        "World Cup 2026",
        "knockout",
        "round of",
        "quarter",
        "semi",
        "final",
        "score",
        "scores",
        "fixture",
        "fixtures",
        "match",
        "matches",
        "homeTeam",
        "awayTeam",
        "winner",
        "Spain",
        "Argentina",
        "世界杯",
        "淘汰赛",
        "比分",
        "赛果",
        "西班牙",
        "阿根廷"
      ]
    : keywordsForExtraction(query).filter((keyword) => keyword.length >= 4);
  const excerpts: string[] = [];

  for (const block of scriptBlocks) {
    const text = decodeScriptText(block[1]);
    const lower = text.toLowerCase();
    if (!keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) {
      continue;
    }

    excerpts.push(extractRelevantText(text, query));
    if (excerpts.join("\n").length >= appConfig.search.maxPageChars) {
      break;
    }
  }

  return excerpts.join("\n...\n").slice(0, appConfig.search.maxPageChars);
};

const fetchPageContent = async (
  result: WebSearchResult,
  query: string
): Promise<WebSearchResult> => {
  try {
    const response = await withTimeout(result.url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"
      }
    });

    if (!response.ok) {
      return result;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) {
      return result;
    }

    const html = await response.text();
    const visibleText = stripHtml(html);
    const structuredText = extractStructuredPageText(html, query);
    const text = extractRelevantText(
      [visibleText, structuredText].filter(Boolean).join("\n...\n"),
      query
    );
    return text ? { ...result, content: text } : result;
  } catch {
    return result;
  }
};

const trustLabel = (url: string): string => {
  const score = domainScore(url);
  if (score >= 100) {
    return "official";
  }
  if (score >= 50) {
    return "authoritative";
  }
  if (score < 0) {
    return "low-priority";
  }
  return "general";
};

export const shouldUseWebSearch = (prompt: string): boolean =>
  appConfig.search.enabled && freshInfoPattern.test(prompt);

export const searchWeb = async (
  query: string,
  onProgress?: SearchProgressReporter
): Promise<WebSearchResult[]> => {
  if (!appConfig.search.enabled) {
    return [];
  }

  const providers = selectProviders();
  const queries = buildSearchQueries(query);
  const errors: string[] = [];
  const collected: WebSearchResult[] = seedResultsForQuery(query);
  onProgress?.("正在联网搜索", `准备查询 ${providers.join(", ")}。`, "search");

  for (const provider of providers) {
    for (const searchQuery of queries) {
      try {
        onProgress?.("正在联网搜索", `${provider}: ${searchQuery}`, "search");
        collected.push(...(await runProvider(provider, searchQuery)));
      } catch (error) {
        errors.push(`${provider}/${searchQuery}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const unique = uniqueResults(collected, Math.max(appConfig.search.maxResults * 4, 16));
  const ranked = rankResults(unique, query);

  if (ranked.length === 0) {
    if (errors.length > 0) {
      console.warn(`Web search failed: ${errors.join("; ")}`);
    }
    return [];
  }

  const pageResults = appConfig.search.fetchPages
    ? await Promise.all(
        ranked.map((result, index) => {
          if (index < appConfig.search.maxFetchPages) {
            onProgress?.("正在读取网页", `${result.title} - ${result.url}`, "search");
            return fetchPageContent(result, query);
          }

          return result;
        })
      )
    : ranked;

  return rankResults(pageResults, query).slice(0, appConfig.search.maxResults);
};

export const formatSearchContext = (query: string, results: WebSearchResult[]): string => {
  const now = new Date().toISOString();
  if (results.length === 0) {
    return `联网搜索已触发，但没有获得可用搜索结果。查询：${query}。当前时间：${now}。如果问题依赖最新事实，请明确说明无法从搜索源确认。`;
  }

  const items = results
    .map((result, index) =>
      [
        `[${index + 1}] ${result.title}`,
        `URL: ${result.url}`,
        `Source: ${result.source}`,
        `Trust: ${trustLabel(result.url)}`,
        `Snippet: ${result.snippet || "No snippet"}`,
        result.content ? `Page excerpt: ${result.content}` : undefined
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");

  return `You have web search results for a time-sensitive user question. Current time: ${now}.

Answer using the sources below and cite source URLs in the answer.
Prioritize official or authoritative sources over low-priority SEO, betting, scraped, or prediction pages.
If the user asks for a complete list, actively extract every listed item from the page excerpts before concluding that data is missing.
If sources conflict, explain the conflict and prefer the official source. Do not invent facts that are not supported by the sources.

Query: ${query}

${items}`.slice(0, appConfig.search.maxContextChars);
};
