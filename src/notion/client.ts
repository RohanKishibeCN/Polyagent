const NOTION_API_BASE = "https://api.notion.com/v1";

export class NotionClient {
  private apiKey: string;
  private databaseId: string;

  constructor(apiKey: string, databaseId: string) {
    this.apiKey = apiKey;
    this.databaseId = databaseId;
  }

  private async notionApi(path: string, method = "GET", body?: object): Promise<any> {
    const url = `${NOTION_API_BASE}${path}`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data: any = await res.json();
    if (!res.ok) {
      console.error(`[notion] API error ${res.status}: ${JSON.stringify(data)}`);
      throw new Error(`Notion API error: ${res.status} ${data.message ?? JSON.stringify(data)}`);
    }
    return data;
  }

  async createDailyPage(dateStr: string, summaryText: string): Promise<string> {
    const body = {
      parent: { database_id: this.databaseId },
      properties: {
        "Title": { title: [{ text: { content: `Daily Report — ${dateStr}` } }] },
        "Date": { date: { start: dateStr } },
        "Content": { rich_text: [{ text: { content: summaryText } }] },
      },
    };

    const response = await this.notionApi("/pages", "POST", body);
    return response.id;
  }
}
