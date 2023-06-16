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
    const cleanedString = metadata.query.replace(/[{} ]/g, '');
    const stringArray = cleanedString.split(',');

    transformed.properties['queryFields'] = {
      type: 'string',
      description: `This parameter is used to get this information [${stringArray}] of a ${metadata.type} type, available in ${metadata.program}. return in array of strings.`,
    };
    transformed.required.push('queryFields');
  }

  params.forEach((param) => {
    let type = "unknown";
    const item = param.split("$");

    if (item.length === 3) {
      type = item[2];
    } else if (item.length === 2) {
      type = item[1];
    }
    if (!isScalar(type)) {
      return;
    }
    const transformedType = typeMappings[type];
    transformed.properties[param] = {
      type: transformedType.toLowerCase(),
    };

    // transformed.required.push(param);
  });

  return transformed;
}

function transformString(inputString) {
  var transformedString = inputString.replace(/:/g, "_");
  return transformedString;
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

function replaceVars(input, vars) {
  let output = input;
  Object.entries(vars).forEach(([key, value]) => {
    const pattern = new RegExp(`"{${key.replace(/\$/g, "\\$")}}"`, "g");
    if (typeof value === "string") {
      output = output.replace(pattern, `"${value}"`);
    } else {
      output = output.replace(pattern, value);
    }
  });
  return output;
}

async function api(method: string, path: string, query?: any, body?: string) {
  if (query) {
    Object.keys(query).forEach((key) => (query[key] === undefined ? delete query[key] : {}));
  }
  const querystr = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : "";

  //******************* TODO: use https ***************//
  const url = `http://api.membrane.io/${path}${querystr}`;

  const req = {
    method,
    body,
    headers: {
      Authorization: `Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Ik1qazBRekl5TmtJek9ERTNORFV4TVRjMVF6STRSREk0TlRaRVFVUTVNalV5TnpsQ05UY3dRZyJ9.eyJpc3MiOiJodHRwczovL2F1dGgubWVtYnJhbmUuaW8vIiwic3ViIjoiYXV0aDB8NWE3YzEzZjI2MjBlOWM0NTJhMThjYWRiIiwiYXVkIjoiaHR0cHM6Ly9tZW1icmFuZS5pby9hcGkiLCJpYXQiOjE2ODU1NzA4NjUsImV4cCI6MTY4ODE2Mjg2NSwiYXpwIjoiTmxMSUtEYVF5U1RyeWlQMGE2UUw4bzJOZ1JLMElYTEsiLCJzY29wZSI6Im9mZmxpbmVfYWNjZXNzIn0.szpylBvhRw80Gt18rcXNXdlLgXb52-qEQ5mgbrqUbYfM36TnTUdTCs-qYf8ygFrjS4mw-skICKgd-MfF4pYp8Vcz8qVOsldGeyKqfDc1oosqing_0Vxugjb1l1ybVo9bbLDNOWhh8GDXnnrqlbfbgG7mlu6r471O_CkMU2-DHl1LfotmIbl5G6Kc7VpK6vcyYcAcHg2FC6gM_3472w9Yw-skH42kAVsrZwdxhOkfl9gwcyN-GSrEnwwe1t2rP3FRpYndxsgvCGiJZRLhMIKjczn1XPz58xTNbNGvcUeJlLRAmkGUDJkvIhsw7YsU3aruKATgfqoaIey1YgEQys8zuw`,
      "Content-Type": "application/json",
    },
  };
  return await fetch(url, req);
}

function isScalar(name) {
  return typeof name === "string" && /^(Int|Float|String|Boolean|Void)$/.test(name);
}

export { isScalar, api, replaceVars, extractParams, transformJSON, transformString };
