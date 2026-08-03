import { appConfig } from "../config";

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  source: string;
};

type SearchProvider = "serper" | "brave" | "tavily" | "duckduckgo";

const freshInfoPattern =
  /(最新|现在|目前|今天|昨日|昨天|明天|本周|本月|今年|实时|联网|搜索|查询|查一下|新闻|赛程|赛果|比分|排名|积分榜|淘汰赛|世界杯|欧洲杯|欧冠|英超|NBA|股票|汇率|天气|current|latest|today|yesterday|news|score|schedule|standing|price|weather|world cup|2026)/i;

const stripHtml = (value: string): string =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
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
    return new URL(url).toString();
  } catch {
    return "";
  }
};

const uniqueResults = (results: WebSearchResult[]): WebSearchResult[] => {
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
      title: result.title.trim() || url,
      snippet: stripHtml(result.snippet).slice(0, 600)
    });
  }

  return next.slice(0, appConfig.search.maxResults);
};

const searchSerper = async (query: string): Promise<WebSearchResult[]> => {
  const response = await withTimeout("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": appConfig.search.serperApiKey
    },
    body: JSON.stringify({
      q: query,
      num: appConfig.search.maxResults,
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
    }))
  );
};

const searchBrave = async (query: string): Promise<WebSearchResult[]> => {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(appConfig.search.maxResults));
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
    }))
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
      max_results: appConfig.search.maxResults,
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
    }))
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

  return uniqueResults(results);
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

const fetchPageContent = async (result: WebSearchResult): Promise<WebSearchResult> => {
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

    const text = stripHtml(await response.text()).slice(0, appConfig.search.maxPageChars);
    return text ? { ...result, content: text } : result;
  } catch {
    return result;
  }
};

export const shouldUseWebSearch = (prompt: string): boolean =>
  appConfig.search.enabled && freshInfoPattern.test(prompt);

export const searchWeb = async (query: string): Promise<WebSearchResult[]> => {
  if (!appConfig.search.enabled) {
    return [];
  }

  const errors: string[] = [];

  for (const provider of selectProviders()) {
    try {
      const results = await runProvider(provider, query);
      if (results.length > 0) {
        const pageResults = appConfig.search.fetchPages
          ? await Promise.all(
              results.map((result, index) =>
                index < appConfig.search.maxFetchPages ? fetchPageContent(result) : result
              )
            )
          : results;
        return pageResults;
      }
    } catch (error) {
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (errors.length > 0) {
    console.warn(`Web search failed: ${errors.join("; ")}`);
  }

  return [];
};

export const formatSearchContext = (query: string, results: WebSearchResult[]): string => {
  const now = new Date().toISOString();
  if (results.length === 0) {
    return `联网搜索已触发，但没有获得可用搜索结果。查询：${query}。当前时间：${now}。如果问题依赖最新信息，请明确说明无法从搜索源确认。`;
  }

  const items = results
    .map((result, index) =>
      [
        `[${index + 1}] ${result.title}`,
        `URL: ${result.url}`,
        `摘要: ${result.snippet || "无摘要"}`,
        result.content ? `页面内容摘录: ${result.content}` : undefined
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");

  return `你已获得以下联网搜索结果。当前时间：${now}。请基于这些来源回答，并在答案中列出来源链接；如果来源不足以确认，不要编造。\n查询：${query}\n\n${items}`;
};
