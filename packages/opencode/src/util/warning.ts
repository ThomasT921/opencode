const emitWarning = process.emitWarning.bind(process)

// Google ADC checks the metadata service during local Vertex authentication.
// That expected miss should not write directly over the interactive UI.
process.emitWarning = ((...args: Parameters<typeof process.emitWarning>) => {
  const type = typeof args[1] === "string" ? args[1] : args[1]?.type
  const name = type ?? (args[0] instanceof Error ? args[0].name : undefined)
  if (name === "MetadataLookupWarning") return
  emitWarning(...args)
}) as typeof process.emitWarning
