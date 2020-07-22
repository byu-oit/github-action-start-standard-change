![CI](https://github.com/byu-oit/github-action-start-standard-change/workflows/CI/badge.svg)
![Test as a step](https://github.com/byu-oit/github-action-start-standard-change/workflows/Test%20as%20a%20step/badge.svg)
![Test as a job](https://github.com/byu-oit/github-action-start-standard-change/workflows/Test%20as%20a%20job/badge.svg)

# ![BYU logo](https://www.hscripts.com/freeimages/logos/university-logos/byu/byu-logo-clipart-128.gif) github-action-start-standard-change
A GitHub Action for starting standard change RFCs in BYU's ServiceNow system

## Usage

### Get the inputs

* Get an application in WSO2 that's subscribed to [ServiceNowTableAPI - v1](https://api.byu.edu/store/apis/info?name=ServiceNowTableAPI&version=v1&provider=BYU%2Fthirschi), [StandardChange - v1](https://api.byu.edu/store/apis/info?name=StandardChange&version=v1&provider=BYU%2Fdlb44), [Change_Request - v1](https://api.byu.edu/store/apis/info?name=Change_Request&version=v1&provider=BYU%2Fthirschi), and [Echo - v1](https://api.byu.edu/store/apis/info?name=Echo&version=v1&provider=BYU%2Fbcwinter)
   > In the `byu-oit` GitHub organization, we provide the following secrets to every repo:
   > - `STANDARD_CHANGE_PRODUCTION_CLIENT_KEY`
   > - `STANDARD_CHANGE_PRODUCTION_CLIENT_SECRET`
   > - `STANDARD_CHANGE_SANDBOX_CLIENT_KEY`
   > - `STANDARD_CHANGE_SANDBOX_CLIENT_SECRET`
* Get the alias or sys_id of your standard change template
   >Existing templates can be found here: [Standard Change Template List](https://it.byu.edu/nav_to.do?uri=%2Fu_standard_change_template_list.do)
* Estimate how long a deployment should take, in minutes

### Add to your workflow (making replacements as necessary)

<details>
<summary>In a workflow where the deploy phase is a step, do this...</summary>
<p>

```yaml
on: push
name: Some Pipeline
jobs:
  do-all-the-things:
    runs-on: ubuntu-latest
    steps:
      # Build, unit tests, linting, etc.
      # ...
      - name: Start Standard Change
        uses: byu-oit/github-action-start-standard-change@v1
        id: start-standard-change
        with:
          client-key: ${{ secrets.STANDARD_CHANGE_SANDBOX_CLIENT_KEY }} # You'll want to use the production secrets in production
          client-secret: ${{ secrets.STANDARD_CHANGE_SANDBOX_CLIENT_SECRET }}
          template-id: <alias or sys_id of standard change template>
          minutes-until-planned-end: 30 # Optional, defaults to 15
      # Your actual deployment step would go here
      - name: Deploy
        id: deploy
        run: echo Deploy
      - name: End Standard Change
        uses: byu-oit/github-action-end-standard-change@v1
        if: always() && steps.start-standard-change.outcome == 'success' # Run if RFC started, even if the deploy failed
        with:
          client-key: ${{ secrets.STANDARD_CHANGE_SANDBOX_CLIENT_KEY }}
          client-secret: ${{ secrets.STANDARD_CHANGE_SANDBOX_CLIENT_SECRET }}
          change-sys-id: ${{ steps.start-standard-change.outputs.change-sys-id }}
          work-start: ${{ steps.start-standard-change.outputs.work-start }}
          success: ${{ job.status == 'success' }}
```

</p>
</details>

<details>
<summary>In a workflow where the deploy phase is a job, do this...</summary>
<p>

Have a job with an `id` of `deploy` (or change this example accordingly), then

```yaml
on: push
name: Some Pipeline
jobs:
  # Build, unit tests, linting, etc.
  # ...

  start-standard-change:
    name: Start Standard Change
    needs: <id of previous job>
    runs-on: ubuntu-latest
    steps:
      - name: Start Standard Change
        uses: byu-oit/github-action-start-standard-change@v1
        id: start-standard-change
        with:
          client-key: ${{ secrets.STANDARD_CHANGE_SANDBOX_CLIENT_KEY }} # You'll want to use the production secrets in production
          client-secret: ${{ secrets.STANDARD_CHANGE_SANDBOX_CLIENT_SECRET }}
          template-id: <alias or sys_id of standard change template>
          minutes-until-planned-end: 30 # Optional, defaults to 15
    outputs:
      change-sys-id: ${{ steps.start-standard-change.outputs.change-sys-id }}
      work-start: ${{ steps.start-standard-change.outputs.work-start }}

  deploy:
    name: Deploy
    needs: start-standard-change
    runs-on: ubuntu-latest
    steps:
      # ...

  end-standard-change:
    name: End Standard Change
    needs: [deploy, start-standard-change] # We need to wait on outcome of deploy, and we list start-standard-change so that we can grab its outputs
    if: always() && needs.start-standard-change.result == 'success' # Run if RFC started, even if the deploy failed
    runs-on: ubuntu-latest
    steps:
      - uses: byu-oit/github-action-end-standard-change@v1
        with:
          client-key: ${{ secrets.STANDARD_CHANGE_SANDBOX_CLIENT_KEY }}
          client-secret: ${{ secrets.STANDARD_CHANGE_SANDBOX_CLIENT_SECRET }}
          change-sys-id: ${{ needs.start-standard-change.outputs.change-sys-id }}
          work-start: ${{ needs.start-standard-change.outputs.work-start }}
          success: ${{ needs.deploy.result == 'success' }} # Evaluates to 'true' or 'false'
```

</p>
</details>

>For performance reasons, we'd recommend a workflow where the deploy phase is a step, but sometimes it needs to be a job

## Contributing
Hopefully this is useful to others at BYU. Feel free to ask me some questions about it, but I make no promises about being able to commit time to support it.

### Modifying Source Code

Just run `npm install` locally. There aren't many files here, so hopefully it should be pretty straightforward.

### Cutting new releases

GitHub Actions will run the entry point from the `action.yml`. In our case, that happens to be `/dist/index.js`.

Actions run from GitHub repos. We don't want to check in `node_modules`. Hence, we package the app using `npm run package`.

Then, push to the corresponding branch, respecting SemVer.
