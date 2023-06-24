import { $$ } from "@membrane/membrane-sdk-js";

// generate the json of paramters for function completions
function transformJSON(params, metadata) {
  const typeMappings = {
    Int: "number",
    String: "string",
    Boolean: "boolean",
    Void: "void",
    Float: "number",
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
      newRef = newRef.push(patch);
    }
  }
  return newRef.toString();
}

export {
  createRef,
  isObjectEmpty,
  replaceArgs,
  isScalar,
  extractParams,
  transformJSON,
  transformString,
};
