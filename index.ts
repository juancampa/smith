import { nodes, root, state } from "membrane";
import { LLM } from "./llm";
import { $$ } from "@membrane/membrane-sdk-js";
import {
  createRef,
  extractParams,
  transformJSON,
  transformString,
} from "./utils";

const INDEX = "membrane";
let questionPromise = state.questionPromise ?? null;

export async function question({ args: { task } }) {
  // Query the Pinecone index to find matching tools
  const vector = await root.createEmbedding({ text: task });
  const res = await nodes.pinecone.indexes.one({ name: INDEX }).query({
    top_k: 20,
    includeMetadata: true,
    vector,
    namespace: "fields_functions",
  });
  const { matches } = JSON.parse(res);
  // Pre-defined system tools
  let tools: any = [
    {
      name: "ask",
      description:
        "Useful when you need to ask the user a question, especially when clarifying parameters for the Actions",
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
    {
      name: "tell",
      description:
        "Useful when you need to tell something to the user without expecting a response",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The message to tell the user",
          },
        },
        required: ["message"],
      },
    },
    {
      name: "sleep",
      description:
        "Use this action when you need to wait for a number of seconds before continuing.",
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
  ];

  // Add matching tools to the list
  for (const vector of matches) {
    const ref = vector.metadata.ref;
    const actionObj = {
      name: transformString(vector.id),
      description: vector.metadata.description,
      parameters: transformJSON(extractParams(ref), vector.metadata),
    };
    tools.push(actionObj);
  }
  console.log(JSON.stringify(tools, null, 2));

  const prompt = `Don't make assumptions about what values. Ask for clarification if a user request is ambiguous, use the 'function: ask' to clarify.`;
  const bot = new LLM(prompt, tools);

  const promises: any[] = [];
  let resolved = false;
  let next_prompt = task;

  while (true) {
    if (resolved) {
      break;
    }
    const funResult = await bot.user(next_prompt);

    if (!funResult.function_call) {
      console.log(funResult.content);
      break;
    }

    const fun = funResult.function_call;
    const args = JSON.parse(fun.arguments);

    switch (fun.name) {
      case "ask":
        await ask(args, promises);
        await Promise.all(promises);
        next_prompt = questionPromise.value;
        break;
      case "tell":
        console.log(`tell: ${args.message}`);
        next_prompt = args.message;
        break;
      case "sleep":
        await sleep(args.seconds);
        next_prompt = "sleep done";
        break;
      default:
        console.log(await executeFunction(matches, args, bot, fun));
        resolved = true;
    }
  }
}

export async function createEmbedding({ args: { text } }) {
  text = text.replace(/\n/g, " ");
  const result = await nodes.openai.models
    .one({ id: "text-embedding-ada-002" })
    .createEmbeddings({ input: text });

  return JSON.stringify(JSON.parse(result)[0].embedding);
}

async function ask(action, promises) {
  const promise = new Promise((resolve) => {
    console.log(
      `Please run :answer to resolve the parameter: ${action.question}`
    );
    questionPromise = { question: action.question, value: "", resolve };
  });
  promises.push(promise);
  console.log(`Waiting`);
}

async function executeFunction(matches, args, bot, fun) {
  let result = matches.find((match) => transformString(match.id) === fun.name);
  const actionRef = $$(result.metadata.ref.replace(/#(true|false)/g, ""));

  const ref = createRef(actionRef, args);
  console.log(`Ref: ${ref}`);

  console.log(`Executing: ${fun.name}`);

  if (args.queryFields) {
    const queryResult = await performQuery(ref, args.queryFields);
    return await handleQueryResult(queryResult, bot, fun.name);
  }

  const actionResult = await performAction(ref);

  return await handleActionResult(actionResult, bot, fun.name);
}

async function performAction(ref) {
  const result = await nodes.meta.action({ gref: ref });

  return JSON.parse(result);
}

async function performQuery(ref, queryFields) {
  const result = await nodes.meta.query({ ref, query: `{${queryFields}}` });
  return JSON.parse(result);
}

async function handleQueryResult(queryResult, bot, functionName) {
  const { data } = queryResult;
  let answer = await bot.function(
    JSON.stringify({ result: JSON.stringify(data) }),
    functionName
  );

  if (answer.content === null) {
    const tool = JSON.parse(answer.function_call.arguments);
    answer = tool.message;
  } else {
    answer = answer.content;
  }
  return answer;
}

async function handleActionResult(actionResult, bot, functionName) {
  const { data, errors } = actionResult;
  let result;
  // Check if there are any errors
  if (errors.length > 0) {
    result = `Failed to execute. Error: ${JSON.stringify(errors)}`;
  } else {
    result = `Executed successfully`;
  }

  let answer = await bot.function(result, functionName);

  if (answer.content === null) {
    const tool = JSON.parse(answer.function_call.arguments);
    answer = tool.message;
  } else {
    answer = answer.content;
  }

  return answer;
}

export async function answer({ args: { text } }) {
  if (questionPromise) {
    questionPromise.value = text;
    questionPromise.resolve(text);
  }
}
