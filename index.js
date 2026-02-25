async function main() {
  try {
    console.log("=== 1. ニュース収集 ===");
    await fetchNewsDaily();
    
    console.log("\n=== 2. 自動お掃除 ===");
    await autoCleanupTrash();

    // --- ここを修正 ---
    console.log("\n=== 3. 学術大会情報（2025年度 & 2024年度） ===");
    if (DB_ACADEMIC_ID) {
      // 1. 最新のページ
      console.log(">> 2025年度分をチェック中...");
      await fetchAllConferences("https://www.jspt.or.jp/conference/");
      
      // 2. 2024年度（昨年度）のアーカイブページ
      // ※サイトによって archive.html だったり archive2024.html だったりします
      console.log(">> 2024年度分（下半期含む）をチェック中...");
      await fetchAllConferences("https://www.jspt.or.jp/conference/archive.html");
    }
    // -----------------

    console.log("\n=== 4. PubMed要約 ===");
    await fillPubmedDataWithAI();
    console.log("\n✨ すべての処理が正常に完了しました");
  } catch (e) { console.error("メイン実行エラー:", e.message); }
}

async function fetchAllConferences(targetUrl) {
  try {
    const res = await axios.get(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    const $ = cheerio.load(res.data);
    
    // ページ内のすべてのテーブルを取得
    const tables = $('table').get();
    
    for (const table of tables) {
      const rows = $(table).find('tbody tr').get();
      
      for (const row of rows) {
        const cells = $(row).find('td');
        
        // 5列以上（主催, 名称, 日付, 会場, 備考）あるか確認
        if (cells.length >= 5) {
          const conferenceCell = $(cells[1]);
          const conferenceName = conferenceCell.text().trim();
          let link = conferenceCell.find('a').attr('href');

          // リンクがない、または名称が空ならスキップ
          if (!link || !conferenceName) continue;

          // 相対パス（../detail...等）を絶対パスに変換
          if (!link.startsWith('http')) {
            link = new URL(link, "https://www.jspt.or.jp/conference/").href;
          }

          const dateText = $(cells[2]).text().trim();
          const venueText = $(cells[3]).text().trim();
          const remarksText = $(cells[4]).text().trim();

          // 重複チェック
          const exists = await notion.databases.query({ 
            database_id: DB_ACADEMIC_ID, 
            filter: { property: "URL", url: { equals: link } } 
          });

          if (exists.results.length === 0) {
            await notion.pages.create({
              parent: { database_id: DB_ACADEMIC_ID },
              properties: {
                '大会名称': { title: [{ text: { content: conferenceName } }] },
                'URL': { url: link },
                '開催年月日': { rich_text: [{ text: { content: dateText } }] },
                '会場': { rich_text: [{ text: { content: venueText } }] },
                '備考': { rich_text: [{ text: { content: remarksText } }] }
              }
            });
            console.log(`✅ 登録: ${conferenceName}`);
          }
        }
      }
    }
  } catch (e) { 
    console.error(`学術大会エラー (${targetUrl}):`, e.message); 
  }
}
