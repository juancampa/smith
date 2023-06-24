# Goals

 - Shared between client and server (and thus not in avya-common)
 - Write a fully immutable version of Ref (should I use immutable.js?)
 - Write a consistent version of SchemaTraversal. And RefTraversal?
 - Use flow on all files. Export types
 - Test as much as possible so that I can work on a solid foundation

# Modules

 - Ref. Use Immutable.js so that we don't need a RefBuilder
 - SchemaTraversal. Same as old one but with a consistent interface
 - RefTraversal. Traverses a ref through a schema.
 - Ref normalization/denormalization? Possibly
