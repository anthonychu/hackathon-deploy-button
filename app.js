const path = require('path')
const sodium = require('libsodium-wrappers')
const fetch = require('node-fetch')

const fastify = require('fastify')({
  logger: true
})

fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'public'),
  prefix: '/',
})

fastify.post('/deploy', async (request, reply) => {
  const payload = request.body

  const azureCredentials = {
    clientId: payload.appId,
    clientSecret: payload.appSecret,
    subscriptionId: payload.subscriptionId,
    tenantId: payload.tenantId,
  }

  const secretOptions = {
    githubToken: payload.githubToken, 
    owner: payload.owner, 
    repo: payload.repo,
  }

  await createOrUpdateGitHubSecret(secretOptions, 'AZURE_CREDENTIALS', JSON.stringify(azureCredentials))
  await createOrUpdateGitHubSecret(secretOptions, 'AZURE_ENV_NAME', payload.envName)
  await createOrUpdateGitHubSecret(secretOptions, 'AZURE_LOCATION', payload.location)
  await createOrUpdateGitHubSecret(secretOptions, 'AZURE_SUBSCRIPTION_ID', payload.subscriptionId)
  
  await rerunLatestWorkflow(secretOptions)

  return { status: 'ok' }

})

async function createOrUpdateGitHubSecret({githubToken, owner, repo}, name, value) {
  const { key: publicKey, key_id } = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  }).then(res => res.json())

  await sodium.ready

  const binkey = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL)
  const binsec = sodium.from_string(value)

  const encBytes = sodium.crypto_box_seal(binsec, binkey)
  const encodedSecret = sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL)

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/${name}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({
      key_id,
      encrypted_value: encodedSecret,
    }),
  })

  console.log(response.status)
}

async function rerunLatestWorkflow({githubToken, owner, repo}) {
  const workflowRuns = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs`, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
  }).then(res => res.json())

  const sortedWorkflows = workflowRuns.workflow_runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  const latestWorkflow = sortedWorkflows[0]
  console.log(latestWorkflow)

  if (latestWorkflow.rerun_url) {
    const response = await fetch(latestWorkflow.rerun_url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    })

    console.log(`Rerun workflow: ${response.status}`)
  }
}

const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}
start()
