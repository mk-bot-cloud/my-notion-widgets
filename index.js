const { Client } = require('@notionhq/client');
const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');

// 環境変数の取得（!重要: Secretsの名前と一致している必要があります）
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_INPUT_ID = process.env.DB_INPUT_ID;
const GROQ_KEY = process.env.GROQ_API_KEY; 
const DB_ACADEMIC_ID = process.env.DB_ACADEMIC_CONFERENCE_ID; 

const parser = new Parser();

async function main() {
  try {
    console.log("=== 1. ニュース収集（画像表示重視） ===");
    await fetchNewsDaily();
    
    console.log("\n=== 2. 自動お掃除 ===");
    await autoCleanupTrash();
    
    console.log("\n=== 3. 学術大会情報 ===");
    if (DB_ACADEMIC_ID) await fetchAllConferences();
    
    console.log("\n=== 4. PubMed要約 ===");
    await fillPubmedDataWithAI();
    
    console.log("\n✨ 全プロセスが正常に完了しました");
  } catch (e) {
    console.error("予期せぬエラー:", e.message);
  }
}

async function fetchNewsDaily() {
  const sources = [
    { name: "Ledge.ai", url: "https://ledge.ai/feed/" },
    { name: "ICT教育ニュース", url: "https://ict-enews.net/feed/" },
    { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml" },
    { name: "テクノエッジ", url: "https://www.techno-edge.net/rss20/index.rdf" }
  ];
  const keywords = ["AI", "Notion", "Gemini", "効率化", "自動化", "IT", "ChatGPT", "生成AI"];

  for (const source of sources) {
    try {
      const feed = await parser.parseURL(source.url);
      for (const item of feed.items.slice(0, 10)) {
        const title = item.title.replace(/[\[【].*?[\]】]/g, '').trim();
        if (keywords.some(kw => title.toUpperCase().includes(kw.toUpperCase()))) {
          const exists = await notion.databases.query({ database_id: DB_INPUT_ID, filter: { property: "名前", title: { equals: title } } });
          if (exists.results.length === 0) {
            // 画像URLを取得
            const imageUrl = await getImageUrl(item);
            // Notionへ保存
            await createNotionPage(title, item.link, imageUrl, source.name);
            console.log(`✅ ${source.name} 保存: ${title}`);
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
    } catch (e) { console.error(`${source.name}エラー:`, e.message); }
  }
}

async function getImageUrl(item) {
  // LedgeなどはRSS内に画像URLがある
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  try {
    const res = await axios.get(item.link, { headers: { "User-Agent": "Mozilla/5.0" }, responseType: 'arraybuffer', timeout: 5000 });
    const html = res.data.toString('utf-8');
    const $ = cheerio.load(html);
    return $('meta[property="og:image"]').attr('content') || null;
  } catch (e) { return null; }
}

async function createNotionPage(title, link, imageUrl, sourceName) {
  const children = [];
  
  // 【最重要】ページの中身の先頭に画像を追加
  if (imageUrl) {
    children.push({
      object: "block",
      type: "image",
      image: { type: "external", external: { url: imageUrl } }
    });
  }

  // ブックマークを追加
  children.push({
    object: "block",
    type: "bookmark",
    bookmark: { url: link }
  });

  await notion.pages.create({
    parent: { database_id: DB_INPUT_ID },
    cover: imageUrl ? { type: "external", external: { url: imageUrl } } : null,
    properties: {
      '名前': { title: [{ text: { content: title } }] },
      'URL': { url: link },
      '情報源': { select: { name: sourceName } }
    },
    children: children
  });
}

// お掃除・学術大会は変更なし
async function autoCleanupTrash() {
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - 7);
  try {
    const res = await notion.databases.query({
      database_id: DB_INPUT_ID,
      filter: { and: [{ property: '削除チェック', checkbox: { equals: true } }, { timestamp: 'last_edited_time', last_edited_time: { on_or_before: thresholdDate.toISOString() } }] }
    });
    for (const page of res.results) { await notion.pages.update({ page_id: page.id, archived: true }); }
  } catch (e) { console.error("お掃除エラー:", e.message); }
}

async function fetchAllConferences() {
  try {
    const res = await axios.get("https://www.jspt.or.jp/conference/", { headers: { "User-Agent": "Mozilla/5.0" } });
    const $ = cheerio.load(res.data);
    $('table tbody tr').each(async (i, el) => {
      const cells = $(el).find('td');
      if (cells.length >= 4) {
        const title = $(cells[1]).text().trim();
        const link = $(cells[1]).find('a').attr('href');
        if (link && link.startsWith('http')) {
          const exists = await notion.databases.query({ database_id: DB_ACADEMIC_ID, filter: { property: "URL", url: { equals: link } } });
          if (exists.results.length === 0) {
            await notion.pages.create({
              parent: { database_id: DB_ACADEMIC_ID },
              properties: { '主催学会名': { title: [{ text: { content: $(cells[0]).text().trim() } }] }, '大会名称': { rich_text: [{ text: { content: title } }] }, 'URL': { url: link } }
            });
          }
        }
      }
    });
  } catch (e) { console.error("学術大会エラー:", e.message); }
}

async function fillPubmedDataWithAI() {
  const res = await notion.databases.query({
    database_id: DB_INPUT_ID,
    filter: { and: [{ property: "URL", url: { contains: "pubmed.ncbi.nlm.nih.gov" } }, { property: "タイトル和訳", rich_text: { is_empty: true } }] }
  });
  
  for (const page of res.results) {
    const url = page.properties.URL.url;
    try {
      if (!GROQ_KEY) {
        console.warn("⚠️ Groq API Keyが設定されていないためスキップします");
        continue;
      }
      
      const response = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const $ = cheerio.load(response.data);
      const title = $('h1.heading-title').text().trim();
      const abstract = $('.abstract-content').text().trim().substring(0, 1000);

      console.log(`Groq待機(30秒)... ${title.substring(0, 15)}`);
      await new Promise(r => setTimeout(r, 30000));

      const aiRes = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: `論文を要約しJSONで返せ。{"translatedTitle":"和訳","journal":"雑誌","summary":"要約"}\n\nTitle:${title}\nAbstract:${abstract}` }],
        response_format: { type: "json_object" }
      }, { 
        headers: { 
          "Authorization": `Bearer ${GROQ_KEY.trim()}`, // 前後の空白を削除
          "Content-Type": "application/json" 
        } 
      });

      const aiData = JSON.parse(aiRes.data.choices[0].message.content);
      await notion.pages.update({
        page_id: page.id,
        properties: {
          "タイトル和訳": { rich_text: [{ text: { content: aiData.translatedTitle } }] },
          "ジャーナル名": { rich_text: [{ text: { content: aiData.journal || "" } }] },
          "要約": { rich_text: [{ text: { content: aiData.summary } }] }
        }
      });
      console.log("✅ PubMed要約成功");
    } catch (e) {
      console.error(`❌ PubMedエラー: ${e.response?.data?.error?.message || e.message}`);
    }
  }
}

main();
