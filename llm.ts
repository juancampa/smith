import { nodes } from "membrane";

interface ChatMessage {
  role: string;
  content: string;
  name?: string;
}

export class LLM {
  system: string;
  functions: any[];
  messages: ChatMessage[];

  constructor(system: string, functions: any[] = []) {
    this.system = system;
    this.messages = [];
    if (this.system) {
      this.messages.push({ role: "system", content: this.system });
    }
    this.functions = functions;
  }

  async execute(): Promise<any> {
    const result = await nodes.openai.models.one({ id: "gpt-4-0613" }).completeChat({
      messages: JSON.stringify(this.messages),
      functions: JSON.stringify(this.functions),
    });
    return JSON.parse(result);
  }

  async user(message: string): Promise<any> {
    this.messages.push({ role: "user", content: message });
    const result = await this.execute();
    this.messages.push(result);
    return result;
  }

  async function(message: string, name: string): Promise<any> {
    this.messages.push({ role: "function", content: message, name });
    const result = await this.execute();
    return result;
  }

  async assistant(message: string): Promise<any> {
    this.messages.push({ role: "assistant", content: message });
    const result = await this.execute();
    return result;
  }
}
