import { nodes, root, state } from "membrane";
import { $$ } from "@membrane/membrane-sdk-js";
import { LLM } from "./llm";
import { traverse, SchemaTraversal } from "./schemaUtils";
import {
  createRef,
  extractParams,
  transformJSON,
  transformString,
  computeStringHash,
  repoFromUrl,
  assignEmbeddingsToActions,
} from "./utils";

// The maximum batch size for indexing programs in pinecone
const BATCH_SIZE = 25;
const INDEX = "membrane";

state.directoryPrograms = state.directoryPrograms ?? [];
state.userPrograms = state.userPrograms ?? [];

let questionPromise = state.questionPromise ?? null;

export async function answer({ args: { text } }) {
  if (questionPromise) {
    questionPromise.value = text;
    questionPromise.resolve(text);
  }
}

export async function configure() {
  try {
    await loadDirectoryPrograms();
    await loadUserPrograms();
  } catch (error) {
    throw new Error(error);
  }
}

export async function objetive({ args: { text } }) {
  // Verify that the programs are loaded in pinecone
  if (!state.directoryPrograms.length || !state.userPrograms.length) {
    throw new Error(
      "Invoke `:configure` to load the programs into the Pinecone database."
    );
  }
  // Query the Pinecone index to find matching tools
  const vector = await createEmbedding({ text: text });
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

  const prompt = `Don't make assumptions about what values. Ask for clarification if a user request is ambiguous, use the 'function: ask' to clarify.`;
  const bot = new LLM(prompt, tools);

  const promises: any[] = [];
  let resolved = false;
  let next_prompt = text;

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
        resolved = true;
        console.log(await executeFunction(matches, args, bot, fun));
    }
  }
}

async function createEmbedding({ text }) {
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
    result = `Executed successfully, Results: ${JSON.stringify(data)}`;
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

async function loadDirectoryPrograms() {
  try {
    // Fetching all programs of directory
    const repos = await nodes.github.users
      .one({ name: "membrane-io" })
      .repos.one({ name: "directory" })
      .content.dir.$query(`{ name sha html_url size download_url }`);
    // Filtering the programs by checking if they are submodules
    const isSubmodule = (item: any) => !item.download_url && item.size === 0;
    let actions: any[] = [];
    // Iterate over the filtered submodules and process each one
    await Promise.all(
      repos.filter(isSubmodule).map(async (item) => {
        const sha = item.sha;
        const name: any = item.name;
        const program = state.directoryPrograms.find(
          (program) => program.name === name
        );
        const res = await repoFromUrl(item.html_url as any).$query(
          `{
              name
              content {
                file(path: "memconfig.json") {
                  content
                }
            }
          }`
        );
        // TODO: check if the program is outdated
        const isOutdated = !program || program.sha !== sha;
        if (isOutdated) {
          console.log(`program ${name} is outdated`);
          const content = JSON.parse(res.content?.file?.content as string);
          const t1 = new SchemaTraversal(content.schema);
          const members = new Set();
          traverse(name, t1, null, members, actions, true, null);
          state.directoryPrograms.push(item);
        }
      })
    );
    if (actions.length > 0) {
      await assignEmbeddingsToActions(actions);
      console.log(`saving ${actions.length} nodes.`);

      for (let i = 0; i < actions.length; i += BATCH_SIZE) {
        const group = actions.slice(i, i + BATCH_SIZE);
        await nodes.pinecone.indexes.one({ name: INDEX }).upsert({
          namespace: "fields_functions",
          vectors: JSON.stringify(group),
        });
      }
    }
  } catch (error) {
    throw new Error(error);
  }
}

async function loadUserPrograms() {
  try {
    const programs = await nodes.meta.programs
      .page({ include_schemas: true })
      .items.$query(`{ name, schema }`);
    let actions: any[] = [];
    for (const program of programs) {
      const schema = JSON.parse(program.schema as string);
      if (schema) {
        const hash = computeStringHash(program.schema);
        const userProgram = state.userPrograms.find(
          (item) => item.name === program.name
        );

        // if program exists and hash is the same, enter in the for loop
        if (userProgram?.hash !== hash) {
          console.log(`program ${program.name} is outdated`);
          state.userPrograms.push({ name: program.name, hash });
          // Schema has changed
          const t1 = new SchemaTraversal(schema);
          const members = new Set();
          traverse(program.name, t1, null, members, actions, true, null);
        }
      }
    }

    if (actions.length > 0) {
      // Assign embeddings to actions
      await assignEmbeddingsToActions(actions);
      console.log(`saving ${actions.length} nodes.`);

      // Index the actions in batches to Pinecone
      for (let i = 0; i < actions.length; i += BATCH_SIZE) {
        const group = actions.slice(i, i + BATCH_SIZE);
        await nodes.pinecone.indexes.one({ name: INDEX }).upsert({
          namespace: "fields_functions",
          vectors: JSON.stringify(group),
        });
      }
    }
  } catch (error) {
    throw new Error(error);
  }
}
