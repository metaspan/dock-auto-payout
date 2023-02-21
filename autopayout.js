/**
 * autopayout.js
 *  
 * Claim and distribute validator staking rewards for your stakers
 *
 * Hacked by: Derek Colley // derek@metaspan.com
 * https://github.com/metaspan/dock-auto-payout
 * 
 * Original author: Mario Pino | @mariopino:matrix.org
 * https://github.com/Colm3na/polkadot-auto-payout
 */

const { DockAPI } = require('@docknetwork/sdk')
const dock = new DockAPI()

const keyring = require('@polkadot/ui-keyring').default;
keyring.initKeyring({
  isDevelopment: false,
});
const fs = require('fs');
const prompts = require('prompts');
const yargs = require('yargs');
const config = require('./config.js');
 
 const argv = yargs
   .scriptName("autopayout.js")
   .option('account', {
     alias: 'a',
     description: 'Account json file path',
     type: 'string',
   })
   .option('password', {
       alias: 'p',
       description: 'Account password, or stdin if this is not set',
       type: 'string',
   })
   .option('validator', {
     alias: 'v',
     description: 'Validator address',
     type: 'string',
   })
   .option('log', {
     alias: 'l',
     description: 'log (append) to autopayout.log file',
     type: 'boolean',
   })
   .usage("node autopayout.js -c keystores/account.json -p password -v validator_stash_address")
   .help()
   .alias('help', 'h')
   .version()
   .alias('version', 'V')
   .argv;
 
 // Exported account json file param
 const accountJSON = argv.account || config.accountJSON;
 
 // Password param
 let password = argv.password || config.password;
 
 // Validator address param
 const validator = argv.validator || config.validator;
 
 // Logging to file param
 const log = argv.log || config.log;
 
 // Node websocket
 const wsProvider = config.nodeWS;
 
 const main = async () => {
 
   console.log("\n\x1b[45m\x1b[1m Dock.io auto payout \x1b[0m\n");
   console.log("\x1b[1m - Check source at https://github.com/metaspan/dock-auto-payout\x1b[0m");
 
   let raw;
   try {
     raw = fs.readFileSync(accountJSON, { encoding: 'utf-8' });
   } catch(err) {
     console.log(`\x1b[31m\x1b[1mError! Can't open ${accountJSON}\x1b[0m\n`);
     process.exit(1);
   }
 
   const account = JSON.parse(raw);
   const address = account.address;
 
   if (!validator) {
     console.log(`\x1b[31m\x1b[1mError! Empty validator stash address\x1b[0m\n`);
     process.exit(1);
   } else {
     console.log(`\x1b[1m -> Validator stash address is\x1b[0m`, validator);
   }
   
   // Prompt user to enter password
   if (!password) {
     const response = await prompts({
       type: 'password',
       name: 'password',
       message: `Enter password for ${address}:`
     });
     password = response.password;
   }
 
  if (password) {
    console.log(`\x1b[1m -> Importing account\x1b[0m`, address);
    const signer = keyring.restoreAccount(account, password);
    signer.decodePkcs8(password);

    // Connect to node
    await dock.init({ address: wsProvider, keyring });
    const api = dock.api;

    // Check account balance
    const accountBalance = await api.derive.balances.all(address);
    const availableBalance = accountBalance.availableBalance;
    if (availableBalance.eq(0)) {
      console.log(`\x1b[31m\x1b[1mError! Account ${address} doesn't have available funds\x1b[0m\n`);
      process.exit(1);
    }
    console.log(`\x1b[1m -> Account ${address} available balance is ${availableBalance.toHuman()}\x1b[0m`);
 
    // Get session progress info
    const chainActiveEra = await api.query.staking.activeEra();
    const activeEra = JSON.parse(JSON.stringify(chainActiveEra)).index;
    console.log(`\x1b[1m -> Active era is ${activeEra}\x1b[0m`);
   
    // Check validator unclaimed rewards
    const stakingInfo = await api.derive.staking.account(validator);
    // for some reason, era's after 1183 seem to have different datatype
    const claimedRewards = stakingInfo.stakingLedger.claimedRewards.map(era => Number(era));
    console.log(`\x1b[1m -> Claimed eras: [${claimedRewards.join(',')}]\x1b[0m`);
 
    let transactions = [];
    let unclaimedRewards = [];
    // go back 84 era, before that payouts are lost
    let era = activeEra > 84 ? activeEra - 84 : 0;

    for (era; era < activeEra; era++) {
      const eraPoints = await api.query.staking.erasRewardPoints(era);
      const eraValidators = Object.keys(eraPoints.individual.toHuman());
      if (eraValidators.includes(validator) && !claimedRewards.includes(era)) {
        console.log(`validator ${validator} has unclaimed rewards in era ${era}`)
        transactions.push(api.tx.staking.payoutStakers(validator, era));
        unclaimedRewards.push(era);
      // } else {
      //   console.log(`validator ${validator} has no unclaimed payouts in era ${era}`)
      }
    }
    if (transactions.length > 0) {
      console.log(`\x1b[1m -> Unclaimed eras: ${JSON.stringify(unclaimedRewards)}\x1b[0m`);

      // Message: There is currently an ongoing election for new validator candidates. As such staking operations are not permitted.
      // we need to check if staking actions are permitted
      const phase = await api.query.electionProviderMultiPhase.currentPhase()
      if (phase.toString() === 'Off') {
        console.log('electionProviderMultiPhase.currentPhase() is Off, we can submit the batch')
      } else {
        console.log(`electionProviderMultiPhase.currentPhase() is ${phase.toString()}, we can NOT submit the batch`)
        process.exit(1)
      }

      // Claim rewards tx
      const nonce = (await api.derive.balances.account(address)).accountNonce;
      let blockHash = null;
      let extrinsicHash = null;
      let extrinsicStatus = null;
      await api.tx.utility.batch(transactions)
        .signAndSend(
          signer,
          { nonce },
          ({ events = [], status }) => {
            extrinsicStatus = status.type
            if (status.isInBlock) {
              extrinsicHash = status.asInBlock.toHex()
            } else if (status.isFinalized) {
              blockHash = status.asFinalized.toHex()
            }
            console.log(extrinsicStatus, extrinsicHash, blockHash)
          }
        )
      console.log(extrinsicStatus, extrinsicHash, blockHash)
      console.log(`\n\x1b[32m\x1b[1mSuccess! \x1b[37mCheck tx in PolkaScan: https://polkascan.io/kusama/transaction/${blockHash}\x1b[0m\n`);

      if (log) {
        fs.appendFileSync(`autopayout.log`, `${new Date()} - Claimed rewards, transaction hash is ${extrinsicHash}`);
      }
    } else {
      console.log(`\n\x1b[33m\x1b[1mWarning! There are no unclaimed rewards, exiting!\x1b[0m\n`);
    }
    process.exit(0);
  }
}
 
try {
  main();
} catch (error) {
  console.error(error);
}
