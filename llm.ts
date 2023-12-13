import { nodes } from "membrane";

const TEMPERATURE: number = 0.5;

interface ChatMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
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
// gpt-4-1106-preview gpt-3.5-turbo-1106
  async execute(): Promise<any> {
    const result = await nodes.openai.models
      .one({ id: "gpt-3.5-turbo-1106" }) 
      .completeChat({
        temperature: TEMPERATURE,
        messages: this.messages,
        tools: this.functions,
        max_tokens: 3500,
      });
    return result;
  }

  async finalize(): Promise<any> {
    const result = await nodes.openai.models
      .one({ id: "gpt-3.5-turbo-1106" })
      .completeChat({
        temperature: TEMPERATURE,
        messages: this.messages,
        tools: this.functions,
        max_tokens: 3500,
      });
    return result;
  }
  async user(message: string): Promise<any> {
    this.messages.push({ role: "user", content: message });
    const result = await this.execute();
    this.messages.push(result);
    return result;
  }

  async function(message: string, name: string, tool_call_id: string): Promise<any> {
    this.messages.push({ role: "tool", content: message, name, tool_call_id});
    // const result = await this.execute();
    // return result;
  }

  async assistant(message: string, tool_calls: any[]): Promise<any> {
    this.messages.push({ role: "assistant", content: message , tool_calls });
  }
}
