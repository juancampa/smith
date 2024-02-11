import type { SchemaTraversal } from "@membrane/sdk";

export type Tool = {
  id: string;
  metadata: {
    ref: string;
    program: string;
    type: string;
    action: string;
    query?: string;
    description: string;
    isPage: boolean;
  };
};

export function collectTools(
  programName: string,
  t1: SchemaTraversal,
  parentTypeName: string | null,
  memberName: string | null,
  visited: Set<any>,
  result: Tool[],
  l?: number
) {
  const actions = t1.getContext()?.type?.actions;
  const fields = t1.getContext()?.type?.fields;
  const typeName = t1.getContext()?.type.name;
  const level = l ?? 0;
  // const log = (...args) => {
  //   console.log("----".repeat(level), ...args);
  // };
  // log(memberName, t1.ref);

  const isRoot = typeName === "Root";

  for (const action of actions) {
    if (shouldSkipMember(programName, typeName, action.name)) {
      continue;
    }
    if (action.params && Array.isArray(action.params)) {
      // Add null check and array check
      const params = action.params.reduce((obj, item) => {
        // const argsRef = { name: item.name, type: item.type, returnType: action.type };
        const optional = item.optional ? item.optional : false;
        obj[item.name] = `{${item.name}$${item.type}#${optional}}`;
        return obj;
      }, {});
      const dot = isRoot ? "" : ".";
      const args = Object.entries(params).map(
        ([key, value]) => `${key}:"${value}"`
      );

      const id = `${programName}:${typeName}:${action.name}`;

      let ref = programName + t1.ref + dot + action.name;
      if (args?.length > 0) {
        ref += `(${args.join(", ")})`;
      }
      result.push({
        id,
        metadata: {
          ref: ref.replace(/\s/g, ""),
          program: programName,
          type: typeName,
          action: action.name,
          description:
            action.description ||
            `Invokes the action ${action.name} on a instance of type ${typeName} in the program ${programName}.`,
          isPage: false,
        },
      });
    }
  }

  const ref = programName + t1.ref;
  let queriableFields;
  let description;
  let isPage = isPageField(memberName, fields);
  let id;
  if (isPage) {
    t1.enterMember("items", {});
    const itemFields = t1.getContext()?.type?.fields;
    const itemTypeName = t1.getContext()?.type.name;
    queriableFields = getQueriableFields(itemFields || []);
    t1.pop();

    id = `${programName}:${itemTypeName}:list`;
    description = `Queries a collection of ${itemTypeName} items from ${parentTypeName} from program ${programName}. Collection is paginated. Can be used to find ${itemTypeName}. Available values: ${queriableFields}.`;
    isPage = true;
  } else {
    queriableFields = getQueriableFields(fields || []);
    if (queriableFields.length > 1 || queriableFields[0] !== "gref") {
      id = `${programName}:${typeName}:${memberName ?? "root"}`;
      if (typeName === "Root") {
        description = `Queries values from the root node of program ${programName}. Available values: ${queriableFields}.`;
      } else {
        description = `Queries the ${typeName} in ${parentTypeName}.${memberName} from program ${programName}. Available values: ${queriableFields}.`;
      }
    }
  }

  // log(` description: "${description}"`);
  if (description) {
    result.push({
      id,
      metadata: {
        ref: ref.replace(/\s/g, ""),
        program: programName,
        type: typeName,
        action: `${typeName}:${memberName}`,
        query: queriableFields.join(", "),
        description,
        isPage,
      },
    });
  }

  const filteredFields = (fields ?? []).filter(
    (field) =>
      !isPrimitiveTypeName(field.type) &&
      !shouldSkipMember(programName, typeName, field.name) &&
      !isWrapperTypeName(field.type)
  );
  for (const nestedMember of filteredFields) {
    // if (nestedMember.params?.length) {
    const args = (nestedMember.params ?? []).reduce((acc, field) => {
      const optional = field.optional ?? false;
      acc[field.name] = `{${memberName ? memberName : nestedMember.name}$${
        field.name
      }$${field.type}#${optional}}`;
      return acc;
    }, {});

    if (!visited.has(nestedMember)) {
      visited.add(nestedMember);
      t1.enterMember(nestedMember.name, args);
      collectTools(
        programName,
        t1,
        typeName,
        nestedMember.name,
        visited,
        result,
        level + 1
      );
      t1.pop();
    }
  }
}

function isPageField(memberName: string | null, fields) {
  return (
    memberName === "page" &&
    fields.find((field) => field.name === "items") &&
    fields.find((field) => field.name === "next")
  );
}

function isWrapperTypeName(typeName: string) {
  return typeName === "Ref" || typeName === "List";
}

function shouldSkipMember(
  programName: string,
  typeName: string,
  memberName: string
) {
  if (programName === "me" && /ask|tell/.test(memberName)) {
    // These are already provided
    return true;
  }
  return (
    typeName === "Root" &&
    (memberName === "tests" ||
      memberName === "endpoint" ||
      memberName === "email" ||
      memberName === "configure")
  );
}

function getQueriableFields(fields) {
  return fields
    .filter((field) => isPrimitiveTypeName(field.type))
    .map((field) => field.name);
}

function isPrimitiveTypeName(name) {
  return /^(Int|Float|String|Boolean|Void|Json|Ref)$/.test(name);
}

// TODO: consider storing names with underscores instead of colons
export const toToolName = (n: string) => n.replace(/:/g, "_");
