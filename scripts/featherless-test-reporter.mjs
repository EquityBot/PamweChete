// Only test-runner events count; generated stdout cannot attest to a passing check.
export default async function* report(source) {
 for await (const event of source) {
  if (event.type === "test:pass" || event.type === "test:fail") {
   yield JSON.stringify({ type: event.type, name: event.data.name }) + "\n";
  }
 }
}
