import { state, nodes } from "membrane";
import { Tool, toToolName } from "./schemaUtils";
import { extractParams, transformJSON } from "./utils";

const TEMPERATURE: number = 0.4;

interface ChatMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

export type OpenAITool = {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
};

export const BUILT_IN_TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "completeSubtasks",
      description:
        "This tool must be used to mark subtasks as done. If refreshTools is true, the available tools list will be refreshed based on the next subtask.",
      parameters: {
        type: "object",
        properties: {
          subtaskIds: {
            type: "array",
            items: { type: "number" },
          },
          refreshTools: {
            type: "boolean",
          },
        },
        required: ["subtaskIds", "refreshTools"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "completeTask",
      description:
        'This tool must be used when the task is done or no more progress can be made. The result argument is the final message to the user in markdown. Any relevant grefs should be passed to the user in the message using markdown link syntax. e.g. "This is [the final result](gref here)" so that they can see what was done',
      parameters: {
        type: "object",
        properties: {
          result: {
            type: "string",
          },
          error: {
            type: "string",
          },
        },
        required: ["result"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "addSubtasks",
      description: "This tool must be used to add subtasks to the current task",
      parameters: {
        type: "object",
        properties: {
          subtasks: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["subtasks"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask",
      description:
        'Ask the user a question. Can be used to clarify tool arguments, subtasks or the main task. The question argument must use markdown format. Relevant gref to nodes can be passed if needed using markdown link syntax. e.g. "Is [this thing](gref here) what you were referring to? I need to know to complete the task".',
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tell",
      description:
        'Tell the user something without expecting a response. Can be used to indicate nodes to the user using their gref. The message argument must use markdown format. Relevant gref to nodes can be passed if needed using markdown link syntax. e.g. "I tried using [the record](gref here) but it did not work. I\'ll continue with...".',
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
          },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sleep",
      description:
        "Wait for a number of seconds before continuing. Only one sleep can be invoked at a time.",
      parameters: {
        type: "object",
        properties: {
          seconds: {
            type: "number",
          },
        },
        required: ["seconds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "requestTools",
      description:
        "Request different tools than the ones provided. The description argument try to match the description of the desired tool. Examples: get values from a github repository, list calendars from Google Calendar, get weather by location.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
          },
        },
        required: ["description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch",
      description:
        "Perform an HTTP GET request. Generally you should try to use more specific tools and use this as a last resort",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
          },
        },
        required: ["url"],
      },
    },
  },
];

export class LLM {
  tools: OpenAITool[];
  messages: ChatMessage[];

  constructor(systemPrompt: string, availableTools: Tool[] = []) {
    this.messages = [];
    if (systemPrompt) {
      this.messages.push({ role: "system", content: systemPrompt });
    }
    this.updateTools(availableTools);
  }

  updateTools(availableTools: Tool[]) {
    // Pre-defined system tools are always available
    this.tools = [...BUILT_IN_TOOLS];

    // Convert tools to OpenAI format
    for (const tool of availableTools) {
      const ref = tool.metadata.ref;
      let id = tool.id;
      const actionObj = {
        type: "function",
        function: {
          name: toToolName(id),
          description: tool.metadata.description,
          parameters: transformJSON(extractParams(ref), tool.metadata),
        },
      };
      this.tools.push(actionObj);
    }
  }

  async execute(ignoreTools: boolean): Promise<any> {
    const result = await nodes.openai.models
      .one({ id: state.modelName ?? "gpt-4-1106-preview" })
      .completeChat({
        temperature: TEMPERATURE,
        messages: this.messages,
        tools: ignoreTools ? undefined : this.tools,
        max_tokens: 3500,
      });

    // HACK: sometimes OpenAI will incorrectly return incorrect tool invocations so here we try to catch and fix them
    if (result.tool_calls) {
      for (let tool_call of result.tool_calls) {
        // Sometimes it will incorrectly return a "functions." prefix
        if (tool_call.function?.name.startsWith("function.")) {
          tool_call.function.name = tool_call.function.name.replace(
            "function.",
            ""
          );
        }
        // Sometimes it incorrectly returns dots instead of underscores
        if (tool_call.function?.name.includes(".")) {
          tool_call.function.name = tool_call.function.name.replace(".", "_");
        }
      }
    }
    this.messages.push(result);
    return result;
  }

  appendUserMessage(message: string) {
    this.messages.push({ role: "user", content: message });
  }

  appendToolResult(message: string, name: string, tool_call_id: string) {
    this.messages.push({ role: "tool", content: message, name, tool_call_id });
  }

  appendAssistantMesssage(message: string, tool_calls: any[]) {
    this.messages.push({ role: "assistant", content: message, tool_calls });
  }

  lastMessage(): ChatMessage {
    return this.messages[this.messages.length - 1];
  }

  // Checks if the last two tool calls are equal
  isRepeatingTools(): boolean {
    let lastTool: ChatMessage | undefined;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (message.role === "assistant" && message.tool_calls) {
        if (!lastTool) {
          lastTool = message;
        } else {
          const names1 = message.tool_calls?.map(
            (tool_call) => tool_call.function.name
          );
          const arguments1 = message.tool_calls?.map(
            (tool_call) => tool_call.function.arguments
          );

          const names2 = lastTool.tool_calls!.map(
            (tool_call) => tool_call.function.name
          );
          const arguments2 = lastTool.tool_calls!.map(
            (tool_call) => tool_call.function.arguments
          );

          return (
            names1?.every((name, index) => name === names2![index]) &&
            arguments1?.every((arg, index) => arg === arguments2![index])
          );
        }
      }
    }
    return false;
  }
}
