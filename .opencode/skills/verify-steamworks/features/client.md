## Sub-features
Read the active App ID, UI language, overlay availability, friends list, achievements, and login status.

## How to get to it (user POV)
Start a signed-in Steam client and use an App ID the account can run. Initialize the built library in the main Node process.

## Driving it with Node
For the Spacewar test application, run `node test/steam-readonly.js 480` and `node test/sdk-readonly.js 480`. Each command compares the App ID returned by Steam with 480 and validates the return types before printing the result.

## Gotchas
This check does not upload scores, change inventory, or prove transport between two Steam accounts. A missing client or entitlement is a test prerequisite, not a passing result.
