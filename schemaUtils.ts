export function traverse(
  programName,
  t1,
  member,
  members,
  withParams,
  isRoot,
  args
) {
  const subName = t1.getContext().type.name;
  if (!isRoot) {
    if (members.has(`${subName}_${member}`)) {
      return;
    }
    members.add(`${subName}_${member}`);
    t1.enterMember(member, args);
  }
  const actions = t1.getContext()?.type?.actions;
  const fields = t1.getContext()?.type?.fields;
  const typeName = t1.getContext()?.type.name;

  if (actions?.length) {
    for (const action of actions) {
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

        let result = programName + ":" + t1.ref + dot + action.name;
        if (args?.length > 0) {
          result += `(${args.join(", ")})`;
        }
        withParams.push({
          id,
          metadata: {
            ref: result.replace(/\s/g, ""),
            program: programName,
            type: typeName,
            action: action.name,
            description:
              action.description ||
              `The ${action.name} action is available in ${programName} program for the ${typeName} type.`,
          },
        });
      }
    }
  }

  // only save a collection of a types
  if (!isPage(typeName)) {
    const ref = programName + ":" + t1.ref;
    const names = fields
      .filter((obj) => isPrimitiveTypeName(obj.type))
      .map((obj) => obj.name);

    // Create the string with comma-separated names
    const queryItems = `{ ${names.join(", ")} }`;
    const id = `${programName}:${typeName}:${member}`;
    withParams.push({
      id,
      metadata: {
        ref: ref.replace(/\s/g, ""),
        program: programName,
        type: typeName,
        action: `${typeName}:${member}`,
        query: queryItems,
        description: `This action is used to get this information ${queryItems} of a ${typeName} type, available in ${programName} program.`,
      },
    });
  }

  let nestedMembers = t1.getContext()?.type.fields;

  if (nestedMembers) {
    nestedMembers = nestedMembers.filter(
      (nestedMember) =>
        !isPrimitiveTypeName(nestedMember.type) &&
        !isWrapperTypeName(nestedMember.type)
    );
    for (const nestedMember of nestedMembers) {
      if (nestedMember.params?.length) {
        const result = nestedMember.params.reduce((obj, item) => {
          const optional = item.optional ? item.optional : false;
          obj[item.name] = `{${member ? member : nestedMember.name}$${
            item.name
          }$${item.type}#${optional}}`;
          return obj;
        }, {});

        traverse(
          programName,
          t1,
          nestedMember.name,
          members,
          withParams,
          false,
          result
        );
      }
      traverse(
        programName,
        t1,
        nestedMember.name,
        members,
        withParams,
        false,
        null
      );
    }
  }
  t1.pop();
}

function isPrimitiveTypeName(name) {
  return (
    typeof name === "string" && /^(Int|Float|String|Boolean|Void)$/.test(name)
  );
}

function isPage(input: string): boolean {
  const lowerCaseInput = input.toLowerCase();
  return (
    lowerCaseInput.includes("collection") ||
    lowerCaseInput.includes("page") ||
    lowerCaseInput.includes("root")
  );
}

function isWrapperTypeName(typeName) {
  return typeName === "Ref" || typeName === "List";
}

function isObject(o) {
  return o && typeof o === "object" && !Array.isArray(o);
}

export class SchemaTraversal {
  private context: any;
  private schema: any;
  private rootType: any;

  constructor(schema, rootType = "Root") {
    this.schema = schema;
    this.context = [{ schema }];
    const type = schema.types.find((t) => t.name === "Root");
    this.rootType = type;
    this.context = [];
    this._pushRoot();
  }
  _pushRoot() {
    this.context.push({
      isRoot: true,
      type: this.rootType,
      schema: this.schema || [],
    });
  }
  getSchema() {
    return this.context[this.context.length - 1].schema;
  }
  getType() {
    return this.context[this.context.length - 1].type;
  }
  getContext() {
    return this.context[this.context.length - 1];
  }
  getScalarFields(filter = {}) {
    if (filter.fields === undefined) {
      filter.fields = true;
    }
    const { fields = [] } = this.getType();
    return [
      ...(filter.fields
        ? fields.filter(
            (f) => !isPrimitiveTypeName(f.type) && !isWrapperTypeName(f.type)
          )
        : []),
    ];
  }
  // if there is no member with the provided name
  enterMember(name, args) {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Expected member name to be a non-empty string");
    }
    if (args && !isObject(args)) {
      throw new Error("Expected args to be an object");
    }
    if (!this.getContext()) {
      return false;
    }
    const { typed, memberKind } = this._getMemberAndKind(name);
    if (!typed) {
      return false;
    }

    let info;
    info = this._getTypedInfo(typed);

    this.context.push({ memberKind, member: typed, args, ...info });
    return true;
  }

  get ref() {
    const { context } = this;
    let i;
    for (i = context.length - 1; i >= 0; --i) {
      if (context[i].isRoot) {
        break;
      }
    }

    let result = "";
    for (i += 1; i < context.length; ++i) {
      result += context[i].member.name;

      if (context[i].args) {
        const args = Object.entries(context[i].args).map(
          ([key, value]) => `${key}:"${value}"`
        );
        result += `(${args.join(", ")})`;
      }

      if (i !== context.length - 1) {
        result += ".";
      }
    }
    return result;
  }

  _getTypedInfo(typed) {
    const typeName = typed.type;
    let type;
    if (isPrimitiveTypeName(typeName)) {
      type = { name: typeName };
    } else {
      type = this.schema.types.find((t) => t.name === typeName);
    }

    return {
      // The schema where typed's type resides
      schema: this.schema,
      // The innertype's type object
      type,
    };
  }

  pop() {
    return this.context.pop();
  }
  _getMemberAndKind(name) {
    const { type } = this.getContext();
    let typed;
    let memberKind;
    if (type.fields) {
      typed = type.fields.find((f) => f.name === name);
      memberKind = "field";
    }
    if (typed === undefined && type.actions) {
      typed = type.actions.find((f) => f.name === name);
      memberKind = "action";
    }
    return { typed, memberKind };
  }
}
