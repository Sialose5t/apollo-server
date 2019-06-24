import { SDLValidationContext } from 'graphql/validation/ValidationContext';
import {
  ASTVisitor,
  isObjectType,
  isScalarType,
  isInterfaceType,
  isUnionType,
  isEnumType,
  isInputObjectType,
  Kind,
  // ObjectTypeExtensionNode,
  isTypeDefinitionNode,
  ObjectTypeExtensionNode,
  InterfaceTypeExtensionNode,
  // TypeExtensionNode,
} from 'graphql';
import { errorWithCode, logServiceAndType } from '../../utils';

type FederatedExtensionNode = (
  | ObjectTypeExtensionNode
  | InterfaceTypeExtensionNode) & {
  serviceName?: string | null;
};

export function PossibleTypeExtensions(
  context: SDLValidationContext,
): ASTVisitor {
  const schema = context.getSchema();
  const definedTypes = Object.create(null);

  for (const def of context.getDocument().definitions) {
    if (isTypeDefinitionNode(def)) {
      definedTypes[def.name.value] = def;
    }
  }

  const checkExtension = (node: FederatedExtensionNode) => {
    const typeName = node.name.value;
    const defNode = definedTypes[typeName];
    const existingType = schema && schema.getType(typeName);

    const serviceName = node.serviceName;
    if (!serviceName) return;

    if (defNode) {
      const expectedKind = defKindToExtKind[defNode.kind];
      const baseKind = defNode.kind;
      if (expectedKind !== node.kind) {
        context.reportError(
          errorWithCode(
            'EXTENSION_OF_WRONG_KIND',
            logServiceAndType(serviceName, typeName) +
              `\`${typeName}\` was originally defined as a ${baseKind} and can only be extended by a ${expectedKind}. ${serviceName} defines ${typeName} as a ${
                node.kind
              }`,
          ),
        );
      }
    } else if (existingType) {
      const expectedKind = typeToExtKind(existingType);
      const baseKind = typeToKind(existingType);
      if (expectedKind !== node.kind) {
        context.reportError(
          errorWithCode(
            'EXTENSION_OF_WRONG_KIND',
            logServiceAndType(serviceName, typeName) +
              `\`${typeName}\` was originally defined as a ${baseKind} and can only be extended by a ${expectedKind}. ${serviceName} defines ${typeName} as a ${
                node.kind
              }`,
          ),
        );
      }
    } else {
      context.reportError(
        errorWithCode(
          'EXTENSION_WITH_NO_BASE',
          logServiceAndType(serviceName, typeName) +
            `\`${typeName}\` is an extension type, but \`${typeName}\` is not defined in any service`,
        ),
      );
    }
  };

  return {
    ObjectTypeExtension: checkExtension,
    InterfaceTypeExtension: checkExtension,
  };
}

function typeToExtKind(type: any) {
  if (isScalarType(type)) {
    return Kind.SCALAR_TYPE_EXTENSION;
  } else if (isObjectType(type)) {
    return Kind.OBJECT_TYPE_EXTENSION;
  } else if (isInterfaceType(type)) {
    return Kind.INTERFACE_TYPE_EXTENSION;
  } else if (isUnionType(type)) {
    return Kind.UNION_TYPE_EXTENSION;
  } else if (isEnumType(type)) {
    return Kind.ENUM_TYPE_EXTENSION;
  } else if (isInputObjectType(type)) {
    return Kind.INPUT_OBJECT_TYPE_EXTENSION;
  }
  return null;
}

const defKindToExtKind: { [kind: string]: string } = {
  [Kind.SCALAR_TYPE_DEFINITION]: Kind.SCALAR_TYPE_EXTENSION,
  [Kind.OBJECT_TYPE_DEFINITION]: Kind.OBJECT_TYPE_EXTENSION,
  [Kind.INTERFACE_TYPE_DEFINITION]: Kind.INTERFACE_TYPE_EXTENSION,
  [Kind.UNION_TYPE_DEFINITION]: Kind.UNION_TYPE_EXTENSION,
  [Kind.ENUM_TYPE_DEFINITION]: Kind.ENUM_TYPE_EXTENSION,
  [Kind.INPUT_OBJECT_TYPE_DEFINITION]: Kind.INPUT_OBJECT_TYPE_EXTENSION,
};

function typeToKind(type: any) {
  if (isScalarType(type)) {
    return Kind.SCALAR_TYPE_DEFINITION;
  } else if (isObjectType(type)) {
    return Kind.OBJECT_TYPE_DEFINITION;
  } else if (isInterfaceType(type)) {
    return Kind.INTERFACE_TYPE_DEFINITION;
  } else if (isUnionType(type)) {
    return Kind.UNION_TYPE_DEFINITION;
  } else if (isEnumType(type)) {
    return Kind.ENUM_TYPE_DEFINITION;
  } else if (isInputObjectType(type)) {
    return Kind.INPUT_OBJECT_TYPE_DEFINITION;
  }
  return null;
}
