import { execSync } from "child_process";

export class NotionClient {
  private apiKey: string;
  private databaseId: string;

  constructor(apiKey: string, databaseId: string) {
    this.apiKey = apiKey;
    this.databaseId = databaseId;
  }

  private ntnApi(path: string, method = "GET", body?: object): any {
    const args = [`ntn`, `api`, path];
    if (method !== "GET") args.push("-X", method);
    if (body) args.push("-d", JSON.stringify(body));
    args.push("--quiet");

    const result = execSync(args.join(" "), {
      encoding: "utf8",
      env: { ...process.env, NOTION_API_TOKEN: this.apiKey },
      maxBuffer: 10 * 1024 * 1024,
    });
    try { return JSON.parse(result); } catch { return result; }
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

    const response = this.ntnApi("v1/pages", "POST", body);
    return response.id;
  }
}
