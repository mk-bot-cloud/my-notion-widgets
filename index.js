async function fetchAllConferences() {
  const targetUrl = "https://www.jspt.or.jp/conference/"; // または archive.html
  try {
    const res = await axios.get(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    const $ = cheerio.load(res.data);
    
    // ページ内のすべてのテーブルを対象にする
    const tables = $('table').get();
    console.log(`Found ${tables.length} tables. Processing...`);

    for (const table of tables) {
      const rows = $(table).find('tbody tr').get();
      
      for (const row of rows) {
        const cells = $(row).find('td');
        // 5列以上ある行を処理
        if (cells.length >= 5) {
          const conferenceCell = $(cells[1]);
          const conferenceName = conferenceCell.text().trim();
          let link = conferenceCell.find('a').attr('href');

          // 相対パスを絶対パスに補完
          if (link && !link.startsWith('http')) {
            link = new URL(link, "https://www.jspt.or.jp/").href;
          }

          const dateText = $(cells[2]).text().trim();
          const venueText = $(cells[3]).text().trim();
          const remarksText = $(cells[4]).text().trim();

          // リンクがあり、かつ「第〇回」などの名称が入っている場合
          if (link && conferenceName) {
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
              console.log(`✅ 新規登録: ${conferenceName} (${dateText})`);
            }
          }
        }
      }
    }
  } catch (e) { console.error("学術大会エラー:", e.message); }
}
