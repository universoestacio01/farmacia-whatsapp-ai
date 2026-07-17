(function () {
  const whatsappNumber = "5547999999999";
  const message = encodeURIComponent(
    "Ol\u00e1! Quero fazer um pedido na Raia Farm\u00e1cias Delivery.",
  );
  const url = `https://wa.me/${whatsappNumber}?text=${message}`;

  document.querySelectorAll("[data-whatsapp-link]").forEach((element) => {
    element.setAttribute("href", url);
    element.setAttribute("target", "_blank");
    element.setAttribute("rel", "noopener noreferrer");
  });
})();
