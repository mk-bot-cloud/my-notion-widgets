const { Client } = require('@notionhq/client');
const Parser = require('rss-parser');
const axios = require('axios');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const parser = new Parser();
const databaseId = process.env.DB_INPUT_ID;

const sources = [
  { name: "Ledge.ai", url: "https://ledge.ai/feed/" },
  { name: "ICT教育ニュース", url: "https://ict-enews.net/feed/" },
  { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml" },
  { name: "テクノエッジ", url: "https://www.techno-edge.net/rss20/index.rdf" }
];

const keywords = ["AI", "Notion", "Gemini", "効率化", "自動化", "IT", "学校", "教育", "デジタル", "ICT", "調査", "結果", "進路", "将来", "職業", "ChatGPT", "Claude", "Copilot", "NotebookLM", "生成AI", "アップデート", "新機能", "リリース", "発表", "GPT"];
const excludeWords = ["開催", "募集", "セミナー", "ウェビナー", "登壇", "申込", "受講", "展示会", "フェア", "イベント"];

async function run() {
  for (const source of sources) {
    console.log(`--- ${source.name} チェック開始 ---`);
    try {
      const feed = await parser.parseURL(source.url);
      let count = 0;

      for (const item of feed.items) {
        if (count >= 20) break;
        const rawTitle = item.title || "";
        const link = item.link || "";
        if (!rawTitle || !link) continue;

        const cleanTitle = rawTitle
          .replace(/[\[【].*?[\]】]/g, '')
          .replace(/^ITmedia\s*[:：]\s*/g, '')
          .trim();

        const isHit = keywords.some(kw => cleanTitle.toUpperCase().includes(kw.toUpperCase()));
        const isExcluded = excludeWords.some(ew => cleanTitle.includes(ew));

        if (isHit && !isExcluded) {
          if (!(await isRegistered(cleanTitle))) {
            const articleData = await extractContent(link);
            await createNotionPage(cleanTitle, link, articleData.image, articleData.body);
            console.log(`✅ 保存: ${cleanTitle}`);
            count++;
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
    } catch (e) {
      console.error(`${source.name}エラー: ${e.message}`);
    }
  }
}

async function isRegistered(title) {
  const response = await notion.databases.query({
    database_id: databaseId,
    filter: { property: '名前', title: { equals: title } }
  });
  return response.results.length > 0;
}

async function extractContent(url) {
  try {
    const res = await axios.get(url, { 
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' } 
    });
    const html = res.data;
    const imgMatch = html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/);
    const bodyMatch = 
      html.match(/<div\s+id=["']cmsBody["']>([\s\S]*?)<\/div>/) || 
      html.match(/<div\s+class=["']entry-content["']>([\s\S]*?)<\/div>/) ||
      html.match(/<div\s+class=["']post-content["']>([\s\S]*?)<\/div>/);

    let bodyText = "詳細はリンク先を確認してください";
    if (bodyMatch) {
      bodyText = bodyMatch[1].replace(/<[^>]+>/g, '\n').replace(/\n\s*\n/g, '\n').trim();
    }
    return { image: imgMatch ? imgMatch[1] : null, body: bodyText };
  } catch { return { image: null, body: "" }; }
}

async function createNotionPage(title, link, imageUrl, bodyText) {
  const children = [];
  if (imageUrl) children.push({ object: "block", type: "image", image: { type: "external", external: { url: imageUrl } } });
  
  const safeBody = bodyText.substring(0, 1500); // 余裕を持って制限
  children.push({ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: safeBody } }] } });
  children.push({ object: "block", type: "bookmark", bookmark: { url: link } });

  await notion.pages.create({
    parent: { database_id: databaseId },
    cover: imageUrl ? { type: "external", external: { url: imageUrl } } : null,
    properties: { 
      '名前': { title: [{ text: { content: title } }] }, 
      'URL': { url: link } 
    },
    children: children
  });
}
run();
