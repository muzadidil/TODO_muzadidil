import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDcgiLg9_Qv0uqTCJSYhWidAv4rpKlNOMk",
  authDomain: "todo-muza.firebaseapp.com",
  projectId: "todo-muza",
  storageBucket: "todo-muza.firebasestorage.app",
  messagingSenderId: "702060854824",
  appId: "1:702060854824:web:317bd653ac7502d2aebf1d",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
