Work summary above.

```json
{
  "schema": "pms-eval-report/v1",
  "outcome": "completed",
  "summary": "Done.",
  "changedFiles": [],
  "checks": [],
  "gaps": [],
  "answers": {
    "audit": {
      "schemaVersion": "pandamstyle-audit/v1",
      "stack": {
        "framework": {
          "name": "react",
          "version": "19.2.0",
          "evidence": [
            "package.json"
          ]
        },
        "bundler": {
          "name": "webpack",
          "version": "5.97.1",
          "mode": "custom",
          "evidence": [
            "webpack.config.js"
          ]
        },
        "packageManager": {
          "name": "yarn",
          "version": "1.22.22",
          "lockfile": ""
        },
        "node": {
          "declared": ">=22.12.0",
          "observed": ""
        },
        "compatibility": {
          "status": "not_qualified",
          "reason": "custom webpack 5 is not in the qualified matrix"
        }
      },
      "project": {
        "roots": [
          "src"
        ],
        "sourceFiles": {
          "js": 0,
          "jsx": 2,
          "ts": 0,
          "tsx": 0,
          "excludedDirs": [
            "node_modules",
            "dist"
          ]
        }
      },
      "styling": {
        "technologies": [
          "global-css",
          "css-modules",
          "css-custom-properties",
          "inline-style"
        ],
        "tokenSystems": [
          "src/styles/tokens.css"
        ],
        "themeSystems": [
          "prefers-color-scheme"
        ],
        "repeatedStructures": []
      },
      "designSystem": {
        "tokens": {
          "present": true,
          "source": [
            "src/styles/tokens.css"
          ],
          "semanticCoverage": "unknown"
        },
        "recipes": {
          "present": false,
          "candidates": [
            "Button variants"
          ]
        },
        "patterns": {
          "present": false,
          "candidates": []
        },
        "unsupportedOrDynamic": [
          "runtime width style in BookingCard"
        ]
      },
      "migration": {
        "readiness": "medium",
        "opportunities": [],
        "risks": []
      },
      "benchmark": {
        "readiness": "partial",
        "availableChecks": [
          "build"
        ],
        "missingInputs": []
      },
      "recommendedNextAction": "install"
    }
  }
}
```
