import { nodes, root, state } from "membrane";
import { $$, Ref } from "@membrane/sdk";
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

    transformed.properties["queryFields"] = {
      type: "string",
      description: `A list of comma-separated fields to query. Available fields: ${cleanedString}.`,
    };
    transformed.required.push("queryFields");
  }

  params.forEach((param) => {
    const { result, isOptional } = extractIsOptional(param);

    let type = "unknown";
    const item = result.split("$");

    let name: string;
    if (item.length === 3) {
      name = [item[0], item[1]].join("$");
      type = item[2];
    } else {
      //assert(item.length === 2);
      name = item[0];
      type = item[1];
    }
    const transformedType = typeMappings[type];
    if (!transformedType) {
      return;
    }
    transformed.properties[name] = {
      type: transformedType.toLowerCase(),
    };
    if (!isOptional) {
      transformed.required.push(name);
    }
  });
  return transformed;
}

// parse param$type$#optional and return the boolean and the string of param$type
function extractIsOptional(str) {
  const splitArray = str.split("#");
  const extractedValue = splitArray[splitArray.length - 1];
  const isOptional =
    extractedValue === "true"
      ? true
      : extractedValue === "false"
      ? false
      : null;
  const result = splitArray.slice(0, splitArray.length - 1).join("#");
  return { result, isOptional };
}

function extractParams(inputString) {
  const regex = /\{(.*?)\}/g;
  const params = [];
  let match;

  while ((match = regex.exec(inputString)) !== null) {
    params.push(match[1]);
  }
  return params;
}

function isScalar(name) {
  return (
    typeof name === "string" &&
    /^(Int|Float|String|Boolean|Json|Void)$/.test(name)
  );
}

function isObjectEmpty(obj) {
  return Object.keys(obj).length === 0;
}

// Replaces the arg templates (e.g. arg$Type#true) for actual values provided by the LLM.
function replaceArgs(obj, argValues) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const val = (value as string).replace(/[{} ]/g, "");
    const argSplit = val.split("$");
    let argName;
    if (argSplit.length === 3) {
      argName = [argSplit[0], argSplit[1]].join("$");
    } else {
      argName = argSplit[0];
    }
    const argValue = argValues[argName];
    if (argValue !== undefined && argValue !== "" && argValue !== "undefined") {
      result[key] = argValue;
    }
  }

  // console.log("REPLACED ARGS");
  // console.log("    OBJ", obj);
  // console.log("    ARGVALUES", argValues);
  // console.log("    RESULT", result);

  /// { id: "{id$String#true}", name: "{name$String#true}" }

  // TODO: It's a bad idea to replace stuff in a stringified JSON because it might replace inner content.
  // const jsonString = JSON.stringify(obj);
  // console.log("STRINGIFYING", jsonString);
  // const replacedString = jsonString.replace(regex, replaceFn);

  // console.log("REPLACING", replacedString);
  // const replacedObj = JSON.parse(replacedString, (_, value) => {
  // if (typeof value === "string") {
  //   try {
  //     // console.log("PARSING", value);
  //     const parsedValue = JSON.parse(value);
  //     if (
  //       typeof parsedValue === "boolean" ||
  //       typeof parsedValue === "number"
  //     ) {
  //       return parsedValue;
  //     }
  //     return value;
  //   } catch (error) {}
  // }
  //   return value;
  // });

  // const result = {};
  // for (const key in replacedObj) {
  //   const propertyValue = replacedObj[key];
  //   if (propertyValue !== undefined && propertyValue !== "undefined") {
  //     result[key] = propertyValue;
  //   }
  // }
  return result;
}

// Applies the arguments provided by the LLM to a tool template gref.
function createToolGref(refTemplate: Ref, argValues: any): Ref {
  const program = refTemplate.program + ":";
  let newRef = $$(program);
  for (let elem of refTemplate.path) {
    const argsTemplate = elem.args.toObject();
    newRef = newRef.push(elem.name, replaceArgs(argsTemplate, argValues));
  }
  return newRef;
}

// Create embeddings for every tool description
async function assignEmbeddingsToTools(tools) {
  const descriptions = tools.map((tool) => tool.metadata.description);
  const embeddings = await getAdaEmbedding(descriptions);

  // Assign the embeddings to their corresponding tools
  for (let i = 0; i < embeddings.length; i++) {
    tools[i].vector = embeddings[i].embedding;
  }
}

// Get the Ada embedding for the given inputs.
async function getAdaEmbedding(inputs: string[]): Promise<any> {
  return await nodes.openai.models
    .one({ id: "text-embedding-ada-002" })
    .createEmbeddings({ inputs });
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
  console.log(`Upserting ${vectors.length} vectors.`);
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

export function deleteByPrefix(prefix: string, namespace: string) {
  const vectors = state.vectors[namespace];
  let count = 0;
  if (vectors) {
    for (let i = vectors.length - 1; i >= 0; i--) {
      if (vectors[i].id.startsWith(prefix)) {
        vectors.splice(i, 1);
        count += 1;
      }
    }
  }

  console.log(`Deleted ${count} vectors.`);
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
  assignEmbeddingsToTools,
  createToolGref,
  isObjectEmpty,
  replaceArgs,
  isScalar,
  extractParams,
  transformJSON,
};
