const apiRequest=async(path,options={})=>{
  const response=await fetch(path,{credentials:"same-origin",...options,headers:{"Content-Type":"application/json",...options.headers}});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||"The request could not be completed.");
  return payload
};
const money=amount=>`UGX ${Number(amount||0).toLocaleString("en-UG")}`;
const message=(form,text,isError=false,isPending=false)=>{
  const target=form.querySelector("[data-api-message]");
  if(target){
    target.textContent=text;
    target.classList.toggle("down",isError);
    target.classList.toggle("up",!isError&&!isPending);
    target.classList.toggle("pending",isPending)
  }
};
const rows=(tbody,transactions,kind)=>{
  if(!tbody)return;
  const filtered=transactions.filter(item=>!kind||item.kind===kind);
  tbody.replaceChildren();
  if(!filtered.length){
    const row=document.createElement("tr"),cell=document.createElement("td");
    cell.colSpan=4;cell.textContent="No transactions yet.";row.append(cell);tbody.append(row);return
  }
  for(const item of filtered){
    const row=document.createElement("tr"),date=document.createElement("td"),reference=document.createElement("td"),amount=document.createElement("td"),status=document.createElement("td"),badge=document.createElement("span");
    date.textContent=new Date(item.createdAt).toLocaleDateString();
    reference.textContent=`${item.kind==="deposit"?"Deposit":"Withdrawal"} · ${item.reference}`;
    amount.textContent=money(item.amount);
    badge.className=`badge${item.status==="pending"?" w":""}`;
    badge.textContent=item.status[0].toUpperCase()+item.status.slice(1);
    status.append(badge);row.append(date,reference,amount,status);tbody.append(row)
  }
};

const authForm=document.querySelector("#auth-form");
if(authForm){
  const modeFields=document.querySelectorAll("[data-register-field]");
  const title=document.querySelector("#auth-title");
  const submit=authForm.querySelector('[type="submit"]');
  const setMode=mode=>{
    const registering=mode==="register";
    authForm.dataset.mode=registering?"register":"login";
    document.querySelector("#identifier-field").hidden=registering;
    authForm.elements.identifier.required=!registering;
    title.textContent=registering?"Create your account":"Sign in";
    submit.textContent=registering?"Create account · UGX 20,000 deposit":"Sign in";
    modeFields.forEach(field=>{
      field.hidden=!registering;
      field.querySelectorAll("input").forEach(input=>input.required=registering&&input.dataset.required==="true")
    });
    document.querySelector("#auth-switch").textContent=registering?"Already have an account? Sign in":"Don’t have an account? Sign up";
    document.querySelector("#auth-switch").href=registering?"#sign-in":"#register";
    document.querySelector("#auth-description").textContent=registering?"Create an account to get started.":"Welcome back. Log in to your account."
  };
  document.querySelector("#auth-switch").addEventListener("click",event=>{
    event.preventDefault();
    setMode(authForm.dataset.mode==="register"?"login":"register")
  });
  setMode(location.hash==="#register"?"register":"login");
  authForm.addEventListener("submit",async event=>{
    event.preventDefault();
    const fields=new FormData(authForm),registering=authForm.dataset.mode==="register";
    submit.disabled=true;
    message(authForm,"");
    try{
      const result=await apiRequest(`/api/auth/${registering?"register":"login"}`,{
        method:"POST",
        body:JSON.stringify(registering?{
          username:fields.get("username"),email:fields.get("email"),phone:fields.get("phone"),password:fields.get("password")
        }:{identifier:fields.get("identifier"),password:fields.get("password")})
      });
      if(registering){
        location.href="/payment.html";
        return
      }
      location.href="/dashboard.html"
    }catch(error){message(authForm,error.message,true);submit.disabled=false}
  })
}

const backendPage=document.body.dataset.page;
if(backendPage==="payment"){
  loadInitialPayment()
}
if(backendPage&&backendPage!=="login"&&backendPage!=="payment"){
  apiRequest("/api/auth/me").then(({user})=>{
    const name=document.querySelector(".top .user span");
    if(name)name.textContent=user.username;
    document.querySelector(".side .item[href='login.html']")?.addEventListener("click",async event=>{
      event.preventDefault();
      try{await apiRequest("/api/auth/logout",{method:"POST",body:"{}"});location.href="/login.html"}
      catch(error){window.alert(error.message)}
    });
    return user
  }).then(async user=>{
    if(backendPage==="profile")await loadProfile(user);
    if(["dashboard","accounts","deposit","withdraw"].includes(backendPage))await loadSummary(backendPage)
  }).catch(error=>{
    if(error.message==="Please sign in to continue.")location.href="/login.html";
    else window.alert(error.message)
  })
}

async function loadInitialPayment(){
  const button=document.querySelector("[data-demo-pay]");
  const status=document.querySelector("[data-payment-status]");
  try{
    const payment=await apiRequest("/api/payment/initial-deposit");
    document.querySelector("[data-payment-amount]").textContent=money(payment.amount);
    document.querySelector("[data-payment-reference]").textContent=payment.reference;
    if(payment.accountStatus==="active"){
      location.href="/dashboard.html";
      return
    }
    if(payment.status==="completed"){
      status.textContent="Payment is complete. Signing you in…";
      location.href="/dashboard.html";
      return
    }
    if(payment.demoEnabled){
      status.textContent="Demo mode: no real payment will be made.";
      button.textContent=`Pass demo payment · ${money(payment.amount)}`;
      button.disabled=false
    }else{
      status.textContent="Payment provider is not connected yet. Your account remains pending.";
      button.textContent="Payment API not connected";
      button.disabled=true
    }
    button.addEventListener("click",async()=>{
      button.disabled=true;
      status.textContent="Completing demo payment…";
      try{
        const result=await apiRequest("/api/demo/initial-deposit/complete",{
          method:"POST",
          body:"{}"
        });
        status.textContent=result.message;
        location.href="/dashboard.html"
      }catch(error){
        status.textContent=error.message;
        button.disabled=false
      }
    })
  }catch(error){
    if(error.message.includes("signup session has expired")){
      location.href="/login.html#register";
      return
    }
    status.textContent=error.message;
    button.disabled=true
  }
}

async function loadProfile(user){
  const form=document.querySelector("#profile-form");
  if(!form)return;
  form.elements.username.value=user.username;
  form.elements.email.value=user.email;
  form.elements.phone.value=user.phone;
  form.elements.referralCode.value=user.referralCode;
  form.addEventListener("submit",async event=>{
    event.preventDefault();
    const fields=new FormData(form),newPassword=fields.get("newPassword"),confirm=fields.get("confirmPassword");
    if(newPassword&&newPassword!==confirm){message(form,"New passwords do not match.",true);return}
    const button=form.querySelector('[type="submit"]');
    button.disabled=true;message(form,"");
    try{
      const payload={phone:fields.get("phone")};
      if(newPassword){payload.newPassword=newPassword;payload.currentPassword=fields.get("currentPassword")}
      await apiRequest("/api/account/profile",{method:"PATCH",body:JSON.stringify(payload)});
      form.elements.currentPassword.value="";form.elements.newPassword.value="";form.elements.confirmPassword.value="";
      message(form,"Profile updated.")
    }catch(error){message(form,error.message,true)}
    finally{button.disabled=false}
  })
}

async function loadSummary(page){
  const summary=await apiRequest("/api/account/summary");
  document.querySelectorAll("[data-money]").forEach(element=>{
    const key=element.dataset.money;
    if(Object.hasOwn(summary,key))element.textContent=money(summary[key])
  });
  const transactionList=await apiRequest("/api/wallet/transactions");
  if(page==="dashboard")rows(document.querySelector("[data-transactions]"),summary.recentTransactions);
  if(page==="accounts")rows(document.querySelector("[data-transactions]"),transactionList.transactions);
  if(page==="deposit")rows(document.querySelector("[data-transactions]"),transactionList.transactions,"deposit");
  if(page==="withdraw")rows(document.querySelector("[data-transactions]"),transactionList.transactions,"withdrawal");

  document.querySelectorAll("[data-wallet-form]").forEach(form=>{
    if(form.dataset.bound)return;
    form.dataset.bound="true";
    form.addEventListener("submit",async event=>{
      event.preventDefault();
      const button=form.querySelector('[type="submit"]'),fields=new FormData(form);
      button.disabled=true;message(form,"");
      try{
        const result=await apiRequest(`/api/wallet/${form.dataset.walletForm}`,{
          method:"POST",
          body:JSON.stringify({
            amount:fields.get("amount"),
            method:fields.get("method"),
            destination:fields.get("destination")
          })
        });
        message(form,result.message);
        await loadSummary(page)
      }catch(error){message(form,error.message,true)}
      finally{button.disabled=false}
    })
  })
}
