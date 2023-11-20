import { nodes, root, state } from "membrane";
import { $$ } from "@membrane/membrane-sdk-js";
import { magnitude, similarityScores } from "vectorcalc";

state.vectors = state.vectors || {};
// generate the json of paramters for function completions
function transformJSON(params, metadata) {
  const typeMappings = {
    Int: "number",
    String: "string",
    Boolean: "boolean",
    Void: "void",
    Float: "number",
    Json: "string",
  };

  const transformed: any = {
    type: "object",
    properties: {},
    required: [],
  };

  if (metadata.query) {
    const cleanedString = metadata.query.replace(/[{} ]/g, "");
    const stringArray = cleanedString.split(",");

    transformed.properties["queryFields"] = {
      type: "string",
      description: `This parameter is used to get this information [${stringArray}] of a ${metadata.type} type, available in ${metadata.program}. return in array of strings.`,
    };
    transformed.required.push("queryFields");
  }

  params.forEach((param) => {
    const { result, booleanValue } = extractBooleanValue(param);

    let type = "unknown";
    const item = result.split("$");

    if (item.length === 3) {
      type = item[2];
    } else if (item.length === 2) {
      type = item[1];
    }
    if (!isScalar(type)) {
      return;
    }
    const transformedType = typeMappings[type];
    transformed.properties[result] = {
      type: transformedType.toLowerCase(),
    };
    if (!booleanValue) {
      transformed.required.push(result);
    }
  });

  return transformed;
}

function transformString(inputString) {
  var transformedString = inputString.replace(/:/g, "_");
  return transformedString;
}

// parse param$type$#optional and return the boolean and the string of param$type
function extractBooleanValue(str) {
  const splitArray = str.split("#");
  const extractedValue = splitArray[splitArray.length - 1];
  const booleanValue =
    extractedValue === "true"
      ? true
      : extractedValue === "false"
      ? false
      : null;
  const result = splitArray.slice(0, splitArray.length - 1).join("#");
  return { result, booleanValue };
}

function extractParams(inputString: string): string[] {
  const regex = /\{(.*?)\}/g;
  const params: string[] = [];
  let match;

  while ((match = regex.exec(inputString)) !== null) {
    params.push(match[1]);
  }
  return params;
}

function isScalar(name) {
  return (
    typeof name === "string" && /^(Int|Float|String|Boolean|Void)$/.test(name)
  );
}

function isObjectEmpty(obj) {
  return Object.keys(obj).length === 0;
}

// function to replace the args value for the ref
function replaceArgs(obj, args) {
  const regex = /\{([^{}]+)\}/g;

  const replaceFn = (_, match) => {
    const argValue = args[match];
    if (argValue !== undefined && argValue !== "" && argValue !== "undefined") {
      return argValue;
    }
    return undefined;
  };

  const jsonString = JSON.stringify(obj);
  const replacedString = jsonString.replace(regex, replaceFn);
  const replacedObj = JSON.parse(replacedString, (_, value) => {
    if (typeof value === "string") {
      try {
        const parsedValue = JSON.parse(value);
        if (
          typeof parsedValue === "boolean" ||
          typeof parsedValue === "number"
        ) {
          return parsedValue;
        }
        return value;
      } catch (error) {}
    }
    return value;
  });

  const result = {};
  for (const key in replacedObj) {
    const propertyValue = replacedObj[key];
    if (propertyValue !== undefined && propertyValue !== "undefined") {
      result[key] = propertyValue;
    }
  }
  return result;
}

// function to create a new ref with args
function createRef(ref: any, args: any): any {
  const program = ref.program + ":";
  let newRef = $$(program);
  for (let i = 0; i < ref.path.size; ++i) {
    const patch = ref.path.get(i).name;
    const argsRef = ref.path.get(i).args.toObject();
    if (!isObjectEmpty(argsRef)) {
      const obj = replaceArgs(argsRef, args);
      newRef = newRef.push(patch, obj);
    } else {
      newRef = newRef.push(patch, {});
    }
  }
  return newRef.toString();
}

async function assignEmbeddingsToActions(actions) {
  // Collect the descriptions for all actions
  const descriptions = actions.map((action) => action.metadata.description);
  const embeddingPromises: Promise<any>[] = [];
  const embeddingPromise = getAdaEmbedding(descriptions);
  embeddingPromises.push(embeddingPromise);

  const embeddingResult = await embeddingPromise;
  const embeddings = embeddingResult;

  // Assign the embeddings to the corresponding actions
  for (let i = 0; i < embeddings.length; i++) {
    actions[i].vector = embeddings[i].embedding;
  }

  await Promise.all(embeddingPromises);
}

// Get the Ada embedding for the given text.
async function getAdaEmbedding(inputs): Promise<any> {
  const result = await nodes.openai.models
    .one({ id: "text-embedding-ada-002" })
    .createEmbeddings({ inputs });

  return result;
}

// Get a repository from the given URL.
function repoFromUrl(url: string): github.Repository {
  const [, user, repo] = url.match("https://github.com/([^/]+)/([^/]+)")!;
  return nodes.github.users.one({ name: user }).repos.one({ name: repo });
}

// https://stackoverflow.com/questions/6122571/simple-non-secure-hash-function-for-javascript
function computeStringHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash &= hash; // Convert to 32bit integer
  }
  return new Uint32Array([hash])[0].toString(36);
}

function upsert(vectors: any[], namespace: string) {
  // If the namespace doesn't exist, create it.
  if (!state.vectors[namespace]) {
    state.vectors[namespace] = [];
  }

  // Iterate through the items to upsert.
  for (const newItem of vectors) {
    const existingIndex = state.vectors[namespace].findIndex(
      (item) => item.id === newItem.id
    );
    if (existingIndex !== -1) {
      // If the item with the same ID exists, update it.
      state.vectors[namespace][existingIndex] = {
        ...state.vectors[namespace][existingIndex],
        ...newItem,
      };
    } else {
      // If the item doesn't exist, insert it.
      state.vectors[namespace].push(newItem);
    }
  }

  state.vectors[namespace] = state.vectors[namespace].map((item) => {
    const values = magnitude(item.vector);
    return { ...item, vectorMag: values };
  });
}

function query(topN: number, vector: number[], namespace: string) {
  const vectors = state.vectors[namespace];
  if (!vectors) {
    console.log(`Namespace ${namespace} does not exist.`);
    return [];
  }
  const result = similarityScores(vectors, vector, magnitude(vector), topN);
  return result.map(({ vectors, vector, vectorMag, ...rest }) => rest);
}

export {
  query,
  upsert,
  computeStringHash,
  repoFromUrl,
  assignEmbeddingsToActions,
  createRef,
  isObjectEmpty,
  replaceArgs,
  isScalar,
  extractParams,
  transformJSON,
  transformString,
};
