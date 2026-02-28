const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");

const firebaseConfig = {
  apiKey: "AIzaSyCoGrJn27Qj-Ckm0Uh9dBcTlp9iSh5n0qQ",
  authDomain: "study-burn-out.firebaseapp.com",
  projectId: "study-burn-out",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

async function run() {
  const userCredential = await signInWithEmailAndPassword(
    auth,
    "smks8847@gmail.com",
    "JackJack8847"
  );

  const token = await userCredential.user.getIdToken();
  console.log("\nID TOKEN:\n");
  console.log(token);
}

run().catch(console.error);
