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

        let result = programName + t1.ref + dot + action.name;
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
    const ref = programName + t1.ref;
    const names = (fields || [])
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
